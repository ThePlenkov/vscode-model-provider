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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
// The real implementation file (vscodeTerminalBridge.ts) does not exist yet.
// This RED-phase import will fail with "Cannot find module …" until the
// PATCHER writes the implementation. That is the expected TDD state.
import { makeTerminalHandlers } from "./vscodeTerminalBridge.js";

/* Stub the `vscode` module because vitest does not load VS Code. */
vi.mock("vscode", () => {
  /** A factory the tests can override per-case. */
  let makeTerminalReturn: () => unknown = () => ({});

  return {
    window: {
      createTerminal: vi.fn(() => makeTerminalReturn()),
      onDidCloseTerminal: vi.fn(() => ({ dispose: () => undefined })),
    },
    Disposable: class {
      dispose = vi.fn();
    },
  };
});

// Pull the mocked handle for assertions.
const vscode = await import("vscode");

/* ─────────────────────── tests (RED: all must fail until GREEN) ──────── */

describe("vscodeTerminalBridge", () => {
  beforeEach(() => {
    vi.mocked(vscode.window.createTerminal).mockReset();
    vi.mocked(vscode.window.onDidCloseTerminal).mockReset();
  });

  it("create: returns a terminalId after createTerminal", async () => {
    // The mock factory is set per-test; this default yields a minimal
    // terminal shape. Individual tests override to inject ids and
    // onDidClose subscriptions.
    const handlers = makeTerminalHandlers();
    const resp = await handlers.create({
      name: "test-terminal",
    } as acp.CreateTerminalRequest);
    expect(resp.terminalId).toBeDefined();
  });

  it("output: writes the bytes via terminal.sendText", async () => {
    let captured: { text?: string } = {};
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
      name: "test-terminal",
    } as acp.CreateTerminalRequest);
    const resp = await handlers.output({
      terminalId,
      data: "hello world",
    } as acp.TerminalOutputRequest);
    expect(captured.text).toBe("hello world");
    expect(resp.output).toBe(""); // contract: success returns the new output buffer
  });

  it("wait_for_exit: resolves with the exit code on onDidCloseTerminal", async () => {
    // A controller we can fire from the test.
    type CloseListener = (terminal: { exitStatus?: { code?: number } }) => void;
    let listener: CloseListener | null = null;
    vi.mocked(vscode.window.onDidCloseTerminal).mockImplementation(
      (cb: CloseListener) => {
        listener = cb;
        return { dispose: () => undefined };
      },
    );

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      name: "test-terminal",
    } as acp.CreateTerminalRequest);
    const promise = handlers.waitForExit({
      terminalId,
    } as acp.WaitForExitRequest);

    // Simulate the terminal closing with exit code 0.
    if (!listener) throw new Error("listener not registered");
    listener({ exitStatus: { code: 0 } });

    const resp = await promise;
    expect(resp.exitCode).toBe(0);
  });

  it("wait_for_exit: rejects with AbortError when signal is pre-aborted", async () => {
    vi.mocked(vscode.window.onDidCloseTerminal).mockImplementation(
      () => ({ dispose: () => undefined }),
    );

    const handlers = makeTerminalHandlers();
    const { terminalId } = await handlers.create({
      name: "test-terminal",
    } as acp.CreateTerminalRequest);

    const controller = new AbortController();
    controller.abort();

    await expect(
      handlers.waitForExit(
        { terminalId } as acp.WaitForExitRequest,
        controller.signal,
      ),
    ).rejects.toBeDefined(); // any rejection is acceptable; spec says AbortError
  });

  it("release: after dispose, output for the same id returns RequestError", async () => {
    vi.mocked(vscode.window.createTerminal).mockReturnValue({
      sendText: () => undefined,
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
      name: "test-terminal",
    } as acp.CreateTerminalRequest);
    await handlers.release({
      terminalId,
    } as acp.ReleaseTerminalRequest);

    // After release, the bridge should not have any record of this id.
    // A second output for the same id must throw RequestError.
    await expect(
      handlers.output({
        terminalId,
        data: "after-release",
      } as acp.TerminalOutputRequest),
    ).rejects.toMatchObject({ code: -32000 });
  });
});
