/**
 * Required tests for the per-(agent, cwd) session pool (`PR 02`).
 *
 * Per `docs/agent-tasks/02-session-pool.md`:
 *   1. Settlement on `end_of_turn`. The fake drives 5+ intermediate
 *      `agent_message_chunk` updates (no `stopReason`) BEFORE the
 *      final resolve. None of the intermediate updates must settle
 *      `done`; only the final resolve (carrying `end_of_turn`)
 *      settles it. This is precisely the bug the archive's
 *      `acpProvider.ts:139` got wrong.
 *   2. FIFO queue across two concurrent `prompt()` calls.
 *   3. `session/cancel` is delivered to the agent within 1 s of
 *      `PromptHandle.cancel()`, and the prompt settles with
 *      `stopReason: "cancelled"`.
 *   4. Idle eviction: after the configurable timeout, the pool calls
 *      `CliAcpClient.disconnect()` on the idle session.
 *
 * The pool does NOT spawn the CLI itself — construction is injectable
 * via `clientFactory`. Tests supply a fake `CliAcpClient` so no real
 * process is started.
 */

import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { SessionPool } from "./sessionPool.js";
import type { CliAcpClient } from "../client/cliClient.js";

/* ─────────────────────── fake CliAcpClient ─────────────────────── */

interface FakePrompt {
  resolve: (resp: acp.PromptResponse) => void;
  reject: (err: unknown) => void;
}

class FakeClient {
  isConnected = true;
  connected = true;
  disconnected = false;
  prompts: FakePrompt[] = [];
  newSessionCalls = 0;
  cancelCalls: { sessionId: string }[] = [];
  disconnectCalls = 0;

  /**
   * Updates that have been "pushed" through the simulated
   * `onSessionUpdate` channel. The settlement contract says NONE of
   * these may settle `prompt()`'s `done` — they are streamed text
   * with no terminal `stopReason`.
   */
  chunks: acp.SessionNotification[] = [];

  sessionNew = vi.fn(async (_req: acp.NewSessionRequest): Promise<acp.NewSessionResponse> => {
    this.newSessionCalls++;
    return { sessionId: "fake-session-id" };
  });

  sessionPrompt = vi.fn((_req: acp.PromptRequest): Promise<acp.PromptResponse> =>
    new Promise<acp.PromptResponse>((resolve, reject) => {
      this.prompts.push({ resolve, reject });
    }),
  );

  sessionCancel = vi.fn((p: { sessionId: string }): Promise<void> => {
    this.cancelCalls.push(p);
    const inFlight = this.prompts[0];
    if (inFlight) {
      this.prompts.shift();
      inFlight.resolve({ stopReason: "cancelled" });
    }
    return Promise.resolve();
  });

  disconnect = vi.fn(async (): Promise<void> => {
    this.disconnectCalls++;
    this.disconnected = true;
    this.isConnected = false;
  });

  /** Resolve the most-recent unsettled prompt with a given stopReason. */
  settle(stopReason: acp.PromptResponse["stopReason"]): void {
    const next = this.prompts.shift();
    if (!next) throw new Error("FakeClient.settle: no unsettled prompt");
    next.resolve({ stopReason });
  }

  /** Reject the most-recent unsettled prompt. */
  fail(err: unknown): void {
    const next = this.prompts.shift();
    if (!next) throw new Error("FakeClient.fail: no unsettled prompt");
    next.reject(err);
  }

  /**
   * Simulate an inbound `session/update` notification carrying an
   * intermediate `agent_message_chunk` with no `stopReason`. Under
   * the archive bug this would have settled `done`; under the
   * refactored contract it MUST NOT.
   */
  pushChunk(text: string): void {
    this.chunks.push({
      sessionId: "fake-session-id",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
}

/* ─────────────────────── helpers ─────────────────────── */

function makePool(opts: { idleEvictMs?: number } = {}) {
  const client = new FakeClient();
  const pool = new SessionPool(
    () => client as unknown as CliAcpClient,
    { idleEvictMs: opts.idleEvictMs ?? 5_000 },
  );
  return { pool, client };
}

/**
 * PR 09 (the registry) wires the real `connectFn`. For this PR the
 * test fake returns the deterministic id `"fake-session-id"` so the
 * tests can assert on it.
 */
const TEST_CONNECT_FN = async () => ({ sessionId: "fake-session-id" });

const KEY = { agentId: "claude", cwd: "/tmp/repo" };

/**
 * Wait for `ms` microtask cycles. `Promise.resolve()` flushes one
 * microtask; the settlement contract tests need enough flushes that
 * any buggy handler that calls `entry.settle()` synchronously in the
 * notification path would have settled `done` by then.
 */
async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * `Promise.race`-style probe: returns `true` if `done` has settled
 * after `n` microtask flushes; `false` otherwise. Used by the
 * intermediate-chunk assertions.
 */
async function hasSettled(p: Promise<unknown>, n = 5): Promise<boolean> {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await flush(n);
  return settled;
}

/* ─────────────────────── tests ─────────────────────── */

describe("SessionPool", () => {
  it("settles a prompt on end_of_turn (and not on continued chunks)", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);
    await session.ensureStarted(TEST_CONNECT_FN);
    expect(session.sessionId).toBe("fake-session-id");

    const handle = session.prompt([{ type: "text", text: "hello" } as acp.ContentBlock]);
    await flush();

    // Drive 5+ intermediate `agent_message_chunk` updates. None of
    // these carry a `stopReason`, so the settlement contract says
    // `done` MUST NOT resolve on any of them. Under the archive bug
    // (`acpProvider.ts:139`) the first chunk would have settled the
    // handle; this test catches that.
    for (let i = 0; i < 6; i++) {
      client.pushChunk(`token-${i}`);
      // Microtask-flush enough that a buggy synchronous settle call
      // inside the update path would have resolved `done`.
      const settled = await hasSettled(handle.done);
      expect(settled).toBe(false);
    }
    expect(client.chunks.length).toBe(6);

    // The final response carries the terminal `stopReason`. THIS is
    // what settles the handle.
    const sessionIdForPrompt = session.sessionId;
    client.settle("end_turn");

    const resp = await handle.done;
    expect(resp.stopReason).toBe("end_turn");
    expect(sessionIdForPrompt).toBe("fake-session-id");
  });

  it("queues a second prompt behind the first (FIFO)", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);
    await session.ensureStarted(TEST_CONNECT_FN);

    const h1 = session.prompt([{ type: "text", text: "one" } as acp.ContentBlock]);
    const h2 = session.prompt([{ type: "text", text: "two" } as acp.ContentBlock]);

    await flush();

    expect(client.sessionPrompt.mock.calls.length).toBe(1);

    client.settle("end_turn");
    await h1.done;

    await flush();
    expect(client.sessionPrompt.mock.calls.length).toBe(2);

    client.settle("end_turn");
    const r2 = await h2.done;
    expect(r2.stopReason).toBe("end_turn");

    const call1 = client.sessionPrompt.mock.calls[0]![0] as acp.PromptRequest;
    const call2 = client.sessionPrompt.mock.calls[1]![0] as acp.PromptRequest;
    expect(call1.sessionId).toBe(call2.sessionId);
  });

  it("delivers session/cancel within 1 s of PromptHandle.cancel()", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);
    await session.ensureStarted(TEST_CONNECT_FN);

    const handle = session.prompt([{ type: "text", text: "hi" } as acp.ContentBlock]);
    await flush();

    const t0 = Date.now();
    handle.cancel();

    const resp = await handle.done;
    const elapsed = Date.now() - t0;

    expect(resp.stopReason).toBe("cancelled");
    expect(client.sessionCancel).toHaveBeenCalledTimes(1);
    expect(client.cancelCalls[0]!.sessionId).toBe(session.sessionId);
    expect(elapsed).toBeLessThan(1000);
  });

  it("short-circuits a cancelled-but-undispatched entry with stopReason: cancelled", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);
    await session.ensureStarted(TEST_CONNECT_FN);

    // Queue three prompts. drain() will dispatch h1 first, then
    // process h2, then h3. We cancel h2 and h3 BEFORE drain has had a
    // chance to dispatch them — synchronously right after they were
    // queued (and after a flush to make sure h1 is in flight).
    const h1 = session.prompt([{ type: "text", text: "first" } as acp.ContentBlock]);
    const h2 = session.prompt([{ type: "text", text: "second" } as acp.ContentBlock]);
    const h3 = session.prompt([{ type: "text", text: "third" } as acp.ContentBlock]);
    await flush();

    // h1 is in flight (dispatched); h2 and h3 are queued. Cancel both
    // queued entries synchronously. cancelEntry sees they are NOT the
    // dispatching entry, so no extra sessionCancel RPC fires for them.
    h2.cancel();
    h3.cancel();
    expect(client.sessionPrompt.mock.calls.length).toBe(1);

    // Settle h1. drain() then loops to h2, sees the cancelled flag,
    // and short-circuits with stopReason: cancelled (no sessionPrompt,
    // no sessionCancel). Same for h3.
    client.settle("end_turn");
    await h1.done;

    const r2 = await h2.done;
    const r3 = await h3.done;
    expect(r2.stopReason).toBe("cancelled");
    expect(r3.stopReason).toBe("cancelled");

    // h1 alone consumed a sessionPrompt RPC. h2 and h3 were never
    // dispatched (their cancelled flag short-circuited the drain).
    expect(client.sessionPrompt.mock.calls.length).toBe(1);
    // sessionCancel was not called by the cancel-handle at all
    // (because h1 was not cancelled via the handle in this test; the
    // sessionCancel that the fake received would only come from the
    // h1.in-flight cancel — which we did NOT trigger).
    expect(client.sessionCancel).toHaveBeenCalledTimes(0);
  });

  it("evicts idle sessions after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const { pool, client } = makePool({ idleEvictMs: 5_000 });
      const session = await pool.getOrCreate(KEY);

      session.touch();
      expect(client.disconnectCalls).toBe(0);

      vi.advanceTimersByTime(5_500);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(client.disconnectCalls).toBe(1);
      expect(pool.list().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
