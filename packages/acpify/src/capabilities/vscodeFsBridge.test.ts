/**
 * `vscodeFsBridge` — reverse-call handlers for `fs/read_text_file` and
 * `fs/write_text_file`. Created in subagent PR #03 (this file is the
 * pre-implementation scaffold: the four RED-phase tests that the
 * PATCHER must make pass with the GREEN implementation).
 *
 * Per the contract doc `docs/agent-tasks/03-fs-bridge.md`, the
 * public surface is `makeFsHandlers()` returning the two handlers.
 *
 * Subagent home: PR #03 (this file). Consumed by PR #09 (registry)
 * and the SDK client's `connect(...)` handler plumbing from PR #02.
 */

import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
// The real implementation file (vscodeFsBridge.ts) does not exist yet.
// This RED-phase import will fail with "Cannot find module …" until the
// PATCHER writes the implementation. That is the expected TDD state.
import { makeFsHandlers } from "./vscodeFsBridge.js";

/* Stub the `vscode` module because vitest does not load VS Code. */
vi.mock("vscode", () => ({
  workspace: {
    openTextDocument: vi.fn(),
    applyEdit: vi.fn(),
    getWorkspaceFolder: vi.fn(),
  },
  window: {
    showInformationMessage: vi.fn(),
    showTextDocument: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
  },
  // Constructors used by the bridge when building a WorkspaceEdit.
  // The mock does not validate edits — applyEdit is what the tests
  // assert against. Recording the calls here would be noise; the
  // production behaviour is covered by VS Code's own tests.
  WorkspaceEdit: class {
    replace = vi.fn();
    insert = vi.fn();
    delete = vi.fn();
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
}));

// Pull the mocked handle for assertions.
const vscode = await import("vscode");

/* ─────────────────────── tests (RED: all must fail until GREEN) ──────── */

describe("vscodeFsBridge", () => {
  it("read_text_file: returns document text from openTextDocument", async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      // Minimal stub — only `getText` is read by the production code.
      getText: () => "hello",
    } as never);

    const handlers = makeFsHandlers();
    const resp = await handlers.readTextFile({
      path: "/abs/file.txt",
    } as acp.ReadTextFileRequest);
    expect(resp.content).toBe("hello");
  });

  it("read_text_file: returns RequestError when the file is missing", async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(
      new Error("File not found"),
    );

    const handlers = makeFsHandlers();
    await expect(
      handlers.readTextFile({ path: "/abs/missing.txt" } as acp.ReadTextFileRequest),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it("write_text_file: returns content null on applyEdit success", async () => {
    // The bridge calls `showInformationMessage(msg, "Apply", "Cancel")`
    // so the `T extends string` overload applies; cast keeps vi.mocked
    // from picking the unrelated `MessageItem` overload.
    vi.mocked(
      vscode.window.showInformationMessage as (
        message: string,
        ...items: string[]
      ) => Thenable<string | undefined>,
    ).mockResolvedValue("Apply");
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValue(true);

    const handlers = makeFsHandlers();
    const resp = (await handlers.writeTextFile({
      path: "/abs/file.txt",
      content: "new content",
    } as acp.WriteTextFileRequest)) as unknown as { content: null };
    expect(resp.content).toBeNull();
    // Falsification trace: a buggy implementation that silently
    // overwrites without prompting would still pass `resp.content === null`
    // on its own. Asserting the exact prompt + options catches it.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Overwrite /abs/file.txt?",
      "Apply",
      "Cancel",
    );
  });

  it("write_text_file: returns RequestError when user denies", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    const handlers = makeFsHandlers();
    await expect(
      handlers.writeTextFile({
        path: "/abs/file.txt",
        content: "new content",
      } as acp.WriteTextFileRequest),
    ).rejects.toMatchObject({ code: -32000 });
  });
});
