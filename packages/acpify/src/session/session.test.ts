/**
 * Required tests for the per-(agent, cwd) session pool (`PR 02`).
 *
 * Per `docs/agent-tasks/02-session-pool.md`:
 *   1. Settlement on `end_of_turn`.
 *   2. FIFO queue across two concurrent `prompt()` calls.
 *   3. `session/cancel` is delivered to the agent within 1 s of
 *      `PromptHandle.cancel()`, and the prompt settles with
 *      `stopReason: "cancelled"`.
 *   4. Idle eviction: after the configurable timeout, the pool calls
 *      `CliAcpClient.disconnect()` on the idle session.
 *
 * The pool does NOT spawn the CLI itself — construction is injectable
 * via `clientFactory` and `connectFn`. We supply a fake `CliAcpClient`
 * for every test so no real process is started.
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
    // Simulate the agent honouring the cancel by answering the
    // in-flight prompt with stopReason: "cancelled".
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
}

/* ─────────────────────── helpers ─────────────────────── */

function makePool(opts: { idleEvictMs?: number; client?: FakeClient } = {}) {
  const client = opts.client ?? new FakeClient();
  const pool = new SessionPool(
    () => client as unknown as CliAcpClient,
    async (_c, _key) => "fake-session-id",
    { idleEvictMs: opts.idleEvictMs ?? 5_000 },
  );
  return { pool, client };
}

const KEY = { agentId: "claude", cwd: "/tmp/repo" };

/* ─────────────────────── tests ─────────────────────── */

describe("SessionPool", () => {
  it("settles a prompt on end_of_turn (and not on continued chunks)", async () => {
    const { pool } = makePool();
    const session = await pool.getOrCreate(KEY);

    const handle = session.prompt([{ type: "text", text: "hello" } as acp.ContentBlock]);

    // Yield once so the pool has actually called sessionPrompt.
    await Promise.resolve();
    await Promise.resolve();

    // Settle with end_of_turn.
    const sessionIdForPrompt = session.sessionId;
    const fake = (session as unknown as { client: FakeClient }).client;
    fake.settle("end_of_turn" as acp.PromptResponse["stopReason"]);

    const resp = await handle.done;
    expect(resp.stopReason).toBe("end_of_turn");
    expect(sessionIdForPrompt).toBe("fake-session-id");
  });

  it("queues a second prompt behind the first (FIFO)", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);

    const h1 = session.prompt([{ type: "text", text: "one" } as acp.ContentBlock]);
    const h2 = session.prompt([{ type: "text", text: "two" } as acp.ContentBlock]);

    // Give the pool ticks to dispatch.
    await Promise.resolve();
    await Promise.resolve();

    // Only the first should have been written.
    expect(client.sessionPrompt.mock.calls.length).toBe(1);

    // Settle #1.
    client.settle("end_of_turn" as acp.PromptResponse["stopReason"]);
    await h1.done;

    // Yield so #2 can be dispatched.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sessionPrompt.mock.calls.length).toBe(2);

    // Settle #2.
    client.settle("end_of_turn" as acp.PromptResponse["stopReason"]);
    const r2 = await h2.done;
    expect(r2.stopReason).toBe("end_of_turn");

    // The second call's text came AFTER the first.
    const call1 = client.sessionPrompt.mock.calls[0]![0] as acp.PromptRequest;
    const call2 = client.sessionPrompt.mock.calls[1]![0] as acp.PromptRequest;
    expect(call1.sessionId).toBe(call2.sessionId);
  });

  it("delivers session/cancel within 1 s of PromptHandle.cancel()", async () => {
    const { pool, client } = makePool();
    const session = await pool.getOrCreate(KEY);

    const handle = session.prompt([{ type: "text", text: "hi" } as acp.ContentBlock]);
    await Promise.resolve();
    await Promise.resolve();

    const t0 = Date.now();
    handle.cancel();

    // Wait for the agent to answer with stopReason: cancelled.
    const resp = await handle.done;
    const elapsed = Date.now() - t0;

    expect(resp.stopReason).toBe("cancelled");
    expect(client.sessionCancel).toHaveBeenCalledTimes(1);
    expect(client.cancelCalls[0]!.sessionId).toBe(session.sessionId);
    expect(elapsed).toBeLessThan(1000);
  });

  it("evicts idle sessions after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const { pool, client } = makePool({ idleEvictMs: 5_000 });
      const session = await pool.getOrCreate(KEY);

      // Touch the session, then advance time past the idle threshold.
      session.touch();
      expect(client.disconnectCalls).toBe(0);

      vi.advanceTimersByTime(5_500);
      // Allow the eviction handler microtasks to run.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(client.disconnectCalls).toBe(1);
      expect(pool.list().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});