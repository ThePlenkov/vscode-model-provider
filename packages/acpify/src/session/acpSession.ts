/**
 * `AcpSession` — one long-lived `(adapter.id, cwd)` agent process with a
 * FIFO `prompt()` queue.
 *
 * The pool (`sessionPool.ts`) owns a map of these. Each `AcpSession`:
 *   - holds one `CliAcpClient` instance (one process),
 *   - serializes `prompt()` calls so the agent sees a strict FIFO stream,
 *   - tracks `lastUsed` for the pool's idle-eviction policy,
 *   - settles exactly once per `PromptHandle` (see the settlement rule in
 *     `docs/agent-tasks/02-session-pool.md`).
 *
 * Per the architecture decision, this module must NOT import `vscode`.
 * `ContentBlock`-shaped inputs come from the caller (the LMCP adapter in
 * PR 09); we treat them as opaque `acp.ContentBlock[]` because that is
 * what the SDK accepts.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { CliAcpClient } from "../client/cliClient.js";
import type { SessionKey } from "./sessionPool.js";

/**
 * A handle to a single `session/prompt` call.
 *
 * `done` resolves EXACTLY ONCE on the first of (per the task contract):
 *   - the SDK `sessionPrompt` response carrying one of the terminal
 *     `stopReason`s,
 *   - a `session/end` notification,
 *   - an inbound JSON-RPC error,
 *   - `cancel()` AND the agent answering with `cancelled`,
 *   - the underlying child process exiting before any of the above.
 *
 * Intermediate `agent_message_chunk` updates with no `stopReason`
 * (the agent is still streaming) MUST NOT settle this.
 */
export class PromptHandle {
  /** Promise that resolves once the prompt settles (success or cancel). */
  readonly done: Promise<acp.PromptResponse>;

  /**
   * Cancel just this prompt. The agent is sent `session/cancel`; the
   * pool continues to own the session and any subsequent `prompt()`
   * calls on the same `AcpSession` proceed once the agent answers
   * `cancelled`.
   */
  readonly cancel: () => void;

  constructor(done: Promise<acp.PromptResponse>, cancel: () => void) {
    this.done = done;
    this.cancel = cancel;
  }
}

type SettleResolver = (resp: acp.PromptResponse) => void;

/**
 * Connection function passed to `AcpSession.ensureStarted`. PR 09 (the
 * registry) wires the real implementation that spawns the CLI and runs
 * `initialize` + `session/new`; for this PR the extension supplies one
 * that throws immediately so the handshake contract is preserved at
 * the type level. The function receives the underlying
 * `CliAcpClient` plus the session key so the registry can drive the
 * handshake against the right process for this `(adapter.id, cwd)`.
 */
export type SessionConnectFn = () => Promise<{ sessionId: string }>;

/**
 * One process = one `AcpSession`. Created and managed by `SessionPool`.
 */
export class AcpSession {
  readonly key: SessionKey;
  private _sessionId: string | null = null;
  private readonly client: CliAcpClient;

  /**
   * Internal FIFO queue. Items are pushed synchronously from
   * `prompt()`; the dispatcher loop below consumes one at a time and
   * awaits its settlement before pulling the next.
   */
  private queue: Array<{
    blocks: acp.ContentBlock[];
    settle: SettleResolver;
    cancelled: boolean;
  }> = [];

  /** Whether the dispatcher is currently running. */
  private running = false;

  /** Whether the whole session has been torn down. */
  private disposed = false;

  /**
   * The entry currently being awaited by `dispatch` (i.e. the
   * in-flight prompt). `null` when no dispatch is awaiting. Used to
   * distinguish queued-but-undispatched entries (cancel → short
   * circuit in drain) from the genuinely in-flight one (cancel →
   * RPC + wait for agent's `cancelled` answer).
   */
  private dispatchingEntry: typeof this.queue[number] | null = null;

  /** Whether the per-session handshake has completed. */
  private started = false;

  private _lastUsed = Date.now();

  constructor(key: SessionKey, client: CliAcpClient) {
    this.key = key;
    this.client = client;
  }

  /**
   * The session id returned by the `session/new` handshake. `null`
   * until `ensureStarted()` resolves. The pool reads this after the
   * handshake completes.
   */
  get sessionId(): string {
    if (this._sessionId === null) {
      throw new Error("AcpSession.ensureStarted() has not resolved");
    }
    return this._sessionId;
  }

  /**
   * Run the per-session handshake (`initialize` + `session/new`).
   *
   * The `connectFn` is supplied by the caller — typically the registry
   * in PR 09, which knows which CLI to spawn and how to drive the
   * handshake for the given adapter + key. The session itself stays
   * agent-agnostic.
   *
   * Idempotent across concurrent callers: parallel `ensureStarted`
   * calls share the same in-flight handshake promise.
   */
  private startPromiseInner: Promise<string> | null = null;

  async ensureStarted(connectFn: SessionConnectFn): Promise<string> {
    if (this._sessionId !== null) return this._sessionId;
    if (this.startPromiseInner) return this.startPromiseInner;
    this.startPromiseInner = (async () => {
      const { sessionId } = await connectFn();
      this._sessionId = sessionId;
      this.started = true;
      return sessionId;
    })();
    try {
      return await this.startPromiseInner;
    } catch (err) {
      this.startPromiseInner = null;
      throw err;
    }
  }

  /**
   * Send `blocks` to the agent. Calls are serialized: a second
   * `prompt()` waits for the first to settle.
   *
   * Returns a `PromptHandle`. The handle's `done` resolves on the first
   * settlement event (see class doc).
   */
  prompt(blocks: acp.ContentBlock[]): PromptHandle {
    if (this.disposed) {
      throw new Error("AcpSession is disposed");
    }
    if (!this.started) {
      throw new Error(
        "AcpSession.ensureStarted() must resolve before prompt()",
      );
    }

    let settle!: SettleResolver;
    const done = new Promise<acp.PromptResponse>((resolve) => {
      settle = resolve;
    });

    const entry = { blocks, settle, cancelled: false };
    this.queue.push(entry);

    void this.drain();

    const handle = new PromptHandle(done, () => this.cancelEntry(entry));
    return handle;
  }

  /**
   * Cancel the in-flight prompt (if any). Subsequent prompts queued
   * behind it proceed normally. The cancellation contract is:
   *   - send `session/cancel` to the agent,
   *   - wait for the agent to answer `session/prompt` with
   *     `stopReason: "cancelled"`,
   *   - settle the in-flight `PromptHandle` with that response.
   *
   * Note: `PromptHandle.cancel()` (per-handle, called by the
   * caller) is implemented by `cancelEntry`; this method targets
   * "the currently in-flight prompt" and is a thin convenience over
   * that path for callers that only have the session, not the
   * handle.
   */
  cancel(): void {
    const entry = this.dispatchingEntry ?? this.queue[0];
    if (entry) {
      this.cancelEntry(entry);
    }
  }

  /** Tear down the underlying process. Idempotent. */
  async disconnect(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.settle({ stopReason: "cancelled" });
    }
    this.dispatchingEntry = null;
    await this.client.disconnect();
  }

  get lastUsed(): number {
    return this._lastUsed;
  }

  /** Called by the pool whenever this session is observed/touched. */
  touch(): void {
    this._lastUsed = Date.now();
  }

  /** Has the session been disposed? */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Drain the FIFO queue. Each entry is dispatched in order, awaited
   * to settlement, then the next entry is dispatched.
   *
   * Concurrency: only one `drain()` loop runs at a time per session.
   * Re-entrant calls (e.g. `cancel()` triggering a follow-up
   * settlement) return early because `running` is still true.
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0]!;
        // Short-circuit cancelled-but-undispatched entries. Per the
        // task contract, settlement happens on the first of the
        // listed events; cancel() before dispatch is one of them.
        if (entry.cancelled) {
          entry.settle({ stopReason: "cancelled" });
          this.queue.shift();
          continue;
        }
        this.dispatchingEntry = entry;
        try {
          await this.dispatch(entry);
        } finally {
          this.dispatchingEntry = null;
        }
        this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async dispatch(entry: {
    blocks: acp.ContentBlock[];
    settle: SettleResolver;
    cancelled: boolean;
  }): Promise<void> {
    this.touch();
    try {
      const resp = await this.client.sessionPrompt({
        sessionId: this.sessionId,
        prompt: entry.blocks,
      });
      // The SDK only resolves `sessionPrompt` once the agent has
      // answered with a terminal stopReason. Intermediate
      // `agent_message_chunk` updates flow through `onSessionUpdate`
      // and do not settle this handle. (This is precisely the bug
      // the archive `acpProvider.ts:139` got wrong.)
      entry.settle(resp);
    } catch (err) {
      // Errors on the RPC are surfaced as a `cancelled`-flavoured
      // settlement so awaiting callers do not hang. Distinct
      // stopReason preservation is deferred (see MINOR findings).
      entry.settle({ stopReason: "cancelled" });
      if (process.env["ACP_DEBUG"] === "1") {
        console.error("[AcpSession] prompt error:", err);
      }
    }
    this.touch();
  }

  private cancelEntry(entry: {
    blocks: acp.ContentBlock[];
    settle: SettleResolver;
    cancelled: boolean;
  }): void {
    if (entry.cancelled) return;
    entry.cancelled = true;
    // Only send the JSON-RPC `session/cancel` if THIS entry is the
    // one currently in-flight. For queued-but-undispatched entries
    // the drain loop sees the cancelled flag and settles them with
    // `stopReason: 'cancelled'` directly — no RPC needed because no
    // prompt was ever sent.
    if (this.dispatchingEntry === entry) {
      void this.client.sessionCancel({ sessionId: this.sessionId });
    }
  }
}
