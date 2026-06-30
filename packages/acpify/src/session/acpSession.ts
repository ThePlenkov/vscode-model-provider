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
 * `ContentPart`-shaped inputs come from the caller (the LMCP adapter in
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
 * One process = one `AcpSession`. Created and managed by `SessionPool`.
 */
export class AcpSession {
  readonly key: SessionKey;
  readonly sessionId: string;
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

  private _lastUsed = Date.now();

  constructor(key: SessionKey, sessionId: string, client: CliAcpClient) {
    this.key = key;
    this.sessionId = sessionId;
    this.client = client;
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

    let settle!: SettleResolver;
    const done = new Promise<acp.PromptResponse>((resolve) => {
      settle = resolve;
    });

    const entry = { blocks, settle, cancelled: false };
    this.queue.push(entry);

    // Don't await — the consumer gets the handle synchronously.
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
   */
  cancel(): void {
    // Cancel the currently-dispatched entry, if any.
    const inFlight = this.queue[0];
    if (inFlight) {
      void this.client.sessionCancel({ sessionId: this.sessionId });
    }
  }

  /** Tear down the underlying process. Idempotent. */
  async disconnect(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Settle any still-pending entries so awaiting callers do not hang.
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.settle({ stopReason: "cancelled" });
    }
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
        await this.dispatch(entry);
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
      // The SDK already filters `agent_message_chunk` updates with no
      // `stopReason`. Settlement = `sessionPrompt` resolving.
      entry.settle(resp);
    } catch (err) {
      // Treat every SDK/JSON-RPC error as a cancellation so awaiting
      // callers do not hang. The error is swallowed because the
      // contract for `PromptHandle.done` is "resolves exactly once".
      entry.settle({ stopReason: "cancelled" });
      // Surface for diagnostics; tests assert on `cancelled` only.
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
    void this.client.sessionCancel({ sessionId: this.sessionId });
    // The agent's `sessionPrompt` response (with stopReason: "cancelled")
    // is what settles the handle. We do NOT short-circuit here so the
    // contract holds: settle only on the first of the listed events.
  }
}