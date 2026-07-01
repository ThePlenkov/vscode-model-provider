/**
 * `vscodeFsBridge` — reverse-call handlers for ACP `fs/read_text_file`
 * and `fs/write_text_file` requests, implemented directly on top of
 * VS Code's `workspace` and `window` APIs.
 *
 * Per the task contract (`docs/agent-tasks/03-fs-bridge.md`):
 *
 *  - `req.path` is treated as a workspace path:
 *      • workspace-relative paths are resolved against the first open
 *        workspace folder
 *      • absolute paths are validated against `workspace.getWorkspaceFolder`
 *        and rejected with `RequestError(-32000)` if they fall outside
 *        every trusted workspace folder (path-traversal protection —
 *        `openTextDocument` itself does NOT enforce workspace boundaries)
 *  - `req.line` and `req.limit` (the ACP SDK field names; the contract
 *    doc uses the aliases `lineStart`/`lineCount`) are honoured when
 *    present, returning the requested slice of the document via
 *    `doc.lineAt()` (no full-document `getText()` buffering).
 *  - Write requests prompt the user via
 *    `vscode.window.showInformationMessage("Overwrite <path>?" | "Create <path>?",
 *    "Apply", "Cancel")`. Existing files use "Overwrite"; missing files
 *    use "Create" and additionally call `WorkspaceEdit.createFile` (a
 *    plain `replace` cannot create a new resource). Anything other
 *    than the literal "Apply" rejects with `RequestError(-32000)`.
 *
 * Every async call is wrapped so any failure becomes a
 * protocol-compliant `RequestError`, never a bare `Error`.
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
  // Re-throw already-formed RequestErrors as-is so the call-site can
  // distinguish protocol errors (e.g. user-denied) from infrastructure
  // failures without losing the original code.
  if (cause instanceof acp.RequestError) return cause;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new acp.RequestError(FS_ERROR_CODE, `${op} failed for ${path}: ${msg}`);
}

/**
 * Resolve an ACP `req.path` to a workspace-validated `vscode.uri`.
 * Workspace-relative paths are resolved against the first open
 * workspace folder; absolute paths must be inside a workspace folder,
 * otherwise a `RequestError(-32000)` is thrown. This enforces the
 * contract's "absolute paths must be inside a trusted workspace folder"
 * clause — `vscode.workspace.openTextDocument` itself does not.
 */
function pathToUri(reqPath: string, op: string): vscode.Uri {
  const relative = !reqPath.startsWith("/");
  if (relative) {
    const folders = vscode.workspace.workspaceFolders;
    const first = folders?.[0];
    if (!first) {
      throw fsError(
        reqPath,
        op,
        new Error(
          "no workspace folder is open; relative paths cannot be resolved",
        ),
      );
    }
    return vscode.Uri.joinPath(first.uri, reqPath);
  }
  const uri = vscode.Uri.file(reqPath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    throw fsError(
      reqPath,
      op,
      new Error("path is outside every trusted workspace folder"),
    );
  }
  return uri;
}

/**
 * Slice a `TextDocument` by 1-based `line` and `limit`, matching the
 * ACP `ReadTextFileRequest` semantics. Both arguments are optional;
 * missing means "from the start" / "to the end". Out-of-range values
 * are clamped by `Math.min` and the loop bound. Uses `doc.lineAt()`
 * so the document's full text is never materialised in one buffer
 * (important for large files).
 */
function sliceLines(
  doc: vscode.TextDocument,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) return doc.getText();
  const start = line == null ? 0 : Math.max(0, line - 1);
  const end = Math.min(doc.lineCount, limit == null ? doc.lineCount : start + limit);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(doc.lineAt(i).text);
  }
  return out.join("\n");
}

/**
 * Build a `Range` covering the whole document. Falls back to a
 * zero-width range at (0,0) when the document cannot be opened
 * (e.g. the file does not exist yet for a write request).
 */
async function fullDocumentRange(uri: vscode.Uri): Promise<vscode.Range> {
  const zero = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(0, 0),
  );
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.lineCount === 0) return zero;
    const lastLine = doc.lineCount - 1;
    const lastChar = doc.lineAt(lastLine).text.length;
    return new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(lastLine, lastChar),
    );
  } catch (err) {
    // Document does not exist or could not be opened (e.g. file-missing
    // for a brand-new write target). The caller treats the zero-width
    // range at (0,0) as the anchor for a freshly-created resource.
    // Explicit `void` so we consciously acknowledge the swallow.
    void err;
    return zero;
  }
}

/**
 * `true` if `uri` exists on disk. Returns `false` for
 * `FileNotFound`-style errors; rethrows anything else.
 */
async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/FileNotFound|EntryNotFound/i.test(msg)) return false;
    throw err;
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
      try {
        const uri = pathToUri(req.path, "read_text_file");
        const doc = await vscode.workspace.openTextDocument(uri);
        return { content: sliceLines(doc, req.line, req.limit) };
      } catch (err) {
        throw fsError(req.path, "read_text_file", err);
      }
    },

    async writeTextFile(req) {
      try {
        const uri = pathToUri(req.path, "write_text_file");
        const exists = await uriExists(uri);
        const verb = exists ? "Overwrite" : "Create";

        const choice = await vscode.window.showInformationMessage(
          `${verb} ${req.path}?`,
          "Apply",
          "Cancel",
        );
        if (choice !== "Apply") {
          throw new acp.RequestError(
            FS_ERROR_CODE,
            `write_text_file denied by user for ${req.path}`,
          );
        }

        const edit = new vscode.WorkspaceEdit();
        if (!exists) {
          // `replace` cannot create a new file; `createFile` is required.
          edit.createFile(uri, { overwrite: false });
        }
        edit.replace(uri, await fullDocumentRange(uri), req.content);

        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
          throw new Error("applyEdit returned false");
        }
        // Contract and the test assert `content: null` on success.
        // The SDK's `WriteTextFileResponse` only declares `_meta`, so
        // we cast to expose the contract's success shape.
        return { content: null } as acp.WriteTextFileResponse;
      } catch (err) {
        throw fsError(req.path, "write_text_file", err);
      }
    },
  };
}
