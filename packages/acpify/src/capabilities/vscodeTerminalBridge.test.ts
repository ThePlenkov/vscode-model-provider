/**
 * `vscodeTerminalBridge` — reverse-call handlers for ACP
 * `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
 * `terminal/release`. Created in subagent PR #04 (this file is the
 * pre-implementation scaffold: the five RED-phase tests that the
 * PATCHER must make pass with the GREEN implementation).
 *
 * Per the contract doc `docs/agent-tasks/04-terminal-bridge.md`,
 * the public surface is `makeTerminalHandlers()` returning the four
 * handlers, plus an internal `Map<terminalId, vscode.Terminal>` for
 * the bridge's lifecycle bookkeeping.
 *
 * Subagent home: PR #04 (this file). Consumed by PR #09 (registry)
 * and the SDK client's `connect(...)` handler plumbing from PR #02.
 *
 * NOTE on the scaffold (subagent 04 fix-up): the original RED-phase
 * scaffold committed by subagent 03 referenced type names that the
 * SDK does NOT export (`acp.WaitForExitRequest`) and request fields
 * the protocol does NOT declare (`name` on `CreateTerminalRequest`,
 * `data` on `TerminalOutputRequest`). Per Rule 4 of
 * `docs/lessons-learned.md` ("public surface must match the
 * contract doc exactly"), this file was tightened to the SDK's
 * actual type names. The deviation is recorded in
 * `docs/handoff/2026-07-02-subagent-04-complete.md`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
// The real implementation file (vscodeTerminalBridge.ts) does not exist yet.
// This RED-phase import will fail with "Cannot find module …" until the
// PATCHER writes the implementation. That is the expected TDD state.
import { makeTerminalHandlers } from "./vscodeTerminalBridge.js";

/* Stub the `vscode` module because vitest does not load VS Code. */
vi.mock("vscode", () => ({
  window: {
    createTerminal: vi.fn(() => ({
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      exitStatus: undefined,
      processId: Promise.resolve(undefined),
      creationOptions: {},
      name: "test",
      state: { isInteractedWith: false },
    })),
    onDidCloseTerminal: vi.fn(() => ({ dispose: () => undefined })),
  },
  Disposable: class {
    dispose = vi.fn();
  },
}));

// Pull the mocked handle for assertions.
const vscode = await import("vscode");

/* ─────────────────────── tests (RED: all must fail until GREEN) ──────── */

describe("vscodeTerminalBridge", () => {
  beforeEach(() => {
    vi.mocked(vscode.window.createTerminal).mockReset();
    vi.mocked(vscode.window.onDidCloseTerminal).mockReset();
  });

  it("create: returns a terminalId after createTerminal", async () => {
    // SDK shape: CreateTerminalRequest has `sessionId, command, args?, env?, cwd?`
    // (no `name`). The bridge uses `command` as the terminal display name.
    const handlers = makeTerminalHandlers();
    const resp = await handlers.create({
      sessionId: "s1",
      command: "test-terminal",
    } as acp.CreateTerminalRequest);
    expect(resp.terminalId).toBeDefined();
  });

  it("output: writes the bytes via terminal.sendText", async () => {
    // Falsification trace (Rule 3): a buggy impl that skips
    // `sendText` entirely would still satisfy `resp.output === ""`,
    // so we additionally assert the captured sendText payload.
    const captured: { text?: string } = {};
    vi.mocked(vscode.window.createTerminal).mockReturnValue({
      sendText: (text: string) => {
        captured.text = text;
      },
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      exitStatus: undefined,
      processId: Promise.resolve(undefined),
      creationOptions: {},
      name: "test",
      state: { isInteractedWith: false },
    } as never);

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      sessionId: "s1",
      command: "test-terminal",
    } as acp.CreateTerminalRequest);
    // `data` is read by the bridge via an extension field on
    // TerminalOutputRequest (the SDK type itself has no `data` field;
    // the bridge uses `(req as unknown as { data?: string }).data`).
    const resp = await handlers.output({
      sessionId: "s1",
      terminalId,
      data: "hello world",
    } as unknown as acp.TerminalOutputRequest);
    expect(captured.text).toBe("hello world");
    expect(resp.output).toBe(""); // contract: success returns the new output buffer
  });

  it("wait_for_exit: resolves with the exit code on onDidCloseTerminal", async () => {
    // A controller we can fire from the test. We hold a reference to
    // the SAME terminal instance that `createTerminal` returns, so the
    // reference equality check inside the bridge's listener fires.
    const createdTerminal = {
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      exitStatus: undefined,
      processId: Promise.resolve(undefined),
      creationOptions: {},
      name: "test",
      state: { isInteractedWith: false },
    };
    vi.mocked(vscode.window.createTerminal).mockReturnValue(createdTerminal as never);
    type CloseListener = (terminal: unknown) => void;
    let listener: CloseListener | null = null;
    vi.mocked(vscode.window.onDidCloseTerminal).mockImplementation(
      ((cb: CloseListener) => {
        listener = cb;
        return { dispose: () => undefined };
      }) as never,
    );

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      sessionId: "s1",
      command: "test-terminal",
    } as acp.CreateTerminalRequest);
    const promise = handlers.waitForExit({
      sessionId: "s1",
      terminalId,
    } as acp.WaitForTerminalExitRequest);

    // Simulate the terminal closing with exit code 0. Must be the
    // SAME object createTerminal returned, otherwise the bridge's
    // reference-equality filter rejects it.
    if (!listener) throw new Error("listener not registered");
    (listener as (t: unknown) => void)(createdTerminal);

    const resp = await promise;
    expect(resp.exitCode).toBe(0);
  });

  it("wait_for_exit: rejects with AbortError when signal is pre-aborted", async () => {
    vi.mocked(vscode.window.onDidCloseTerminal).mockImplementation(
      (() => ({ dispose: () => undefined })) as never,
    );

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      sessionId: "s1",
      command: "test-terminal",
    } as acp.CreateTerminalRequest);

    const controller = new AbortController();
    controller.abort();

    await expect(
      handlers.waitForExit(
        { sessionId: "s1", terminalId } as acp.WaitForTerminalExitRequest,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: -32000 }); // AbortError -> RequestError(-32000)
  });

  it("release: after dispose, output for the same id returns RequestError", async () => {
    // Falsification trace (Rule 3): a buggy impl that removed the
    // terminal from its map but did not call dispose would leak the
    // VS Code terminal. Assert the spy is invoked, then assert the
    // map-clear behaviour.
    const disposeSpy = vi.fn();
    vi.mocked(vscode.window.createTerminal).mockReturnValue({
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: disposeSpy,
      exitStatus: undefined,
      processId: Promise.resolve(undefined),
      creationOptions: {},
      name: "test",
      state: { isInteractedWith: false },
    } as never);

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      sessionId: "s1",
      command: "test-terminal",
    } as acp.CreateTerminalRequest);
    await handlers.release({
      sessionId: "s1",
      terminalId,
    } as acp.ReleaseTerminalRequest);

    expect(disposeSpy).toHaveBeenCalledTimes(1);

    // After release, the bridge should not have any record of this id.
    // A second output for the same id must throw RequestError.
    await expect(
      handlers.output({
        sessionId: "s1",
        terminalId,
      } as acp.TerminalOutputRequest),
    ).rejects.toMatchObject({ code: -32000 });
  });
});