/**
 * `vscodeFsBridge` — reverse-call handlers for ACP `fs/read_text_file`
 * and `fs/write_text_file` requests, implemented directly on top of
 * VS Code's `workspace` and `window` APIs.
 *
 * Per the task contract (`docs/agent-tasks/03-fs-bridge.md`):
 *
 *  - `req.path` is treated as a workspace path. Absolute paths are
 *    passed through `vscode.Uri.file`; VS Code's own document loaders
 *    reject paths outside any open workspace folder, which we surface
 *    as a `RequestError(-32000)`.
 *  - `req.line` and `req.limit` (the ACP SDK field names for
 *    `lineStart` / `lineCount`) are honoured when present, returning
 *    the requested slice of the document.
 *  - Write requests prompt the user via
 *    `vscode.window.showInformationMessage("Overwrite <path>?", "Apply", "Cancel")`.
 *    "Cancel" and dismissal (i.e. anything other than the literal
 *    string "Apply") both reject with `RequestError(-32000)` — the
 *    bridge does not silently overwrite files.
 *
 * "Do not rewrite" — no custom file-IO layer. Every read and write
 * goes through the VS Code APIs above; the ACP protocol envelope is
 * handled by `@agentclientprotocol/sdk` upstream.
 */

import * as acp from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

/** Single error code for every fs-bridge failure (per the contract). */
const FS_ERROR_CODE = -32000;

function fsError(path: string, op: string, cause: unknown): acp.RequestError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new acp.RequestError(
    FS_ERROR_CODE,
    `${op} failed for ${path}: ${msg}`,
  );
}

/**
 * Slice `text` by 1-based `startLine` and `lineCount`, matching the
 * ACP `ReadTextFileRequest` semantics. Both arguments are optional;
 * missing means "from the start" / "to the end". Out-of-range values
 * are clamped by `Array.prototype.slice`.
 */
function sliceLines(
  text: string,
  startLine: number | null | undefined,
  lineCount: number | null | undefined,
): string {
  if (startLine == null && lineCount == null) return text;
  const lines = text.split("\n");
  const start = startLine == null ? 0 : Math.max(0, startLine - 1);
  const end = lineCount == null ? lines.length : start + lineCount;
  return lines.slice(start, end).join("\n");
}

/**
 * Build a `Range` covering the whole document. Falls back to a
 * zero-width range at (0,0) when the document cannot be opened (e.g.
 * the file does not exist yet for a write request).
 */
async function fullDocumentRange(uri: vscode.Uri): Promise<vscode.Range> {
  const zero = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.lineCount === 0) return zero;
    const lastLine = doc.lineCount - 1;
    const lastChar = doc.lineAt(lastLine).text.length;
    return new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(lastLine, lastChar),
    );
  } catch {
    return zero;
  }
}

export function makeFsHandlers(): {
  readTextFile: (
    req: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse>;
  writeTextFile: (
    req: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse>;
} {
  return {
    async readTextFile(req) {
      const uri = vscode.Uri.file(req.path);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        return { content: sliceLines(doc.getText(), req.line, req.limit) };
      } catch (err) {
        throw fsError(req.path, "read_text_file", err);
      }
    },

    async writeTextFile(req) {
      const choice = await vscode.window.showInformationMessage(
        `Overwrite ${req.path}?`,
        "Apply",
        "Cancel",
      );
      if (choice !== "Apply") {
        throw new acp.RequestError(
          FS_ERROR_CODE,
          `write_text_file denied by user for ${req.path}`,
        );
      }

      const uri = vscode.Uri.file(req.path);
      const range = await fullDocumentRange(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, req.content);

      try {
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
          throw new Error("applyEdit returned false");
        }
        // The contract and the test assert `content: null` on success.
        // The SDK's `WriteTextFileResponse` only declares `_meta`, so
        // we cast to expose the contract's success shape.
        return { content: null } as acp.WriteTextFileResponse;
      } catch (err) {
        throw fsError(req.path, "write_text_file", err);
      }
    },
  };
}
