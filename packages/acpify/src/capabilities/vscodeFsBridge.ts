/**
 * `vscodeFsBridge` — reverse-call handlers for ACP `fs/read_text_file`
 * and `fs/write_text_file` requests, implemented directly on top of
 * VS Code's `workspace` and `window` APIs.
 *
 * Per the task contract (`docs/agent-tasks/03-fs-bridge.md`):
 *
 *  - `req.path` is treated as a workspace path:
 *      • workspace-relative paths are resolved against the first open
 *        workspace folder and post-validated to refuse path-traversal
 *        escapes (`../../etc/passwd` style — `Uri.joinPath` does NOT
 *        clamp `..` segments)
 *      • absolute paths must be inside `workspace.getWorkspaceFolder`
 *        (POSIX, Windows drive, and UNC shapes are all recognised) and
 *        are rejected with `RequestError(-32000)` if they fall outside
 *        every trusted workspace folder
 *  - `req.line` and `req.limit` (the ACP SDK field names; the contract
 *    doc uses the aliases `lineStart`/`lineCount`) are honoured when
 *    present, returning the requested slice of the document via
 *    `doc.lineAt()` (no full-document `getText()` buffering).
 *  - Write requests prompt the user via
 *    `vscode.window.showInformationMessage("Overwrite <path>?" | "Create <path>?",
 *    "Apply", "Cancel")`. Existing files use "Overwrite"; missing files
 *    use "Create" and additionally call `WorkspaceEdit.createFile`.
 *
 * Every async call is wrapped so any failure becomes a
 * protocol-compliant `RequestError`, never a bare `Error`.
 *
 * "Do not rewrite" — no custom file-IO layer. Every read and write
 * goes through the VS Code APIs above; the ACP protocol envelope is
 * handled by `@agentclientprotocol/sdk` upstream.
 *
 * ARCHITECTURE — this file is intentionally reachable only via the
 * sub-entrypoint `@theplenkov/acpify/capabilities/vscodeFsBridge`. It
 * imports the `vscode` runtime module, so a re-export from the
 * package's main `index.ts` would break Node consumers
 * (`ERR_MODULE_NOT_FOUND` at import time, since `vscode` is a
 * devDependency only).
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
 * True when `p` is absolute on any of: POSIX (`/foo`), Windows drive
 * (`C:\\foo`), UNC (`\\\\server\\share\\foo`). VS Code's `Uri.file`
 * accepts each; a string-only check would miss all but the POSIX case.
 */
function pathIsAbsolute(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  return /^[A-Za-z]:[\\/]?/.test(p);
}

/**
 * Resolve an ACP `req.path` (relative) against `folder.uri`, then
 * confirm the result still lives inside the folder — `Uri.joinPath`
 * does NOT clamp `..` segments, so a malicious agent could escape via
 * `../../etc/passwd`. Cross-platform separator-safe comparison.
 */
function resolveRelative(folder: vscode.WorkspaceFolder, reqPath: string) {
  const joined = vscode.Uri.joinPath(folder.uri, reqPath);
  const rootFs = folder.uri.fsPath.replace(/[\\/]+$/, "");
  const joinedFs = joined.fsPath;
  const sameRoot =
    joinedFs === rootFs ||
    joinedFs.startsWith(rootFs + "/") ||
    joinedFs.startsWith(rootFs + "\\");
  return { joined, insideRoot: sameRoot };
}

/**
 * Confirm that `uri` lands inside one of the open workspace folders.
 * Throws `RequestError(-32000)` (via `fsError`) if not.
 */
function assertInsideWorkspace(uri: vscode.Uri, reqPath: string, op: string): void {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    throw fsError(
      reqPath,
      op,
      new Error("path is outside every trusted workspace folder"),
    );
  }
}

/**
 * Map an ACP `req.path` to a workspace-allowed `vscode.Uri`. This
 * enforces the contract's "absolute paths must be inside a trusted
 * workspace folder" clause — `openTextDocument` itself does not.
 */
function pathToUri(reqPath: string, op: string): vscode.Uri {
  if (!pathIsAbsolute(reqPath)) {
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
    const { joined, insideRoot } = resolveRelative(first, reqPath);
    if (!insideRoot) {
      throw fsError(
        reqPath,
        op,
        new Error("relative path escapes the workspace folder"),
      );
    }
    return joined;
  }
  const uri = vscode.Uri.file(reqPath);
  assertInsideWorkspace(uri, reqPath, op);
  return uri;
}

/**
 * Slice a `TextDocument` by 1-based `line` and `limit`, matching the
 * ACP `ReadTextFileRequest` semantics. Both arguments are optional;
 * missing means "from the start" / "to the end".
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
    void err;
    return zero;
  }
}

/** `true` if `uri` exists on disk; `false` for FileNotFound/EntryNotFound. */
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

/**
 * Build the `WorkspaceEdit` for a write request. When `exists` is
 * false, `createFile` runs first so the `replace` can materialise a
 * new resource (a plain `replace` against a missing URI is a no-op
 * on VS Code's WorkspaceEdit).
 */
async function buildWriteEdit(
  uri: vscode.Uri,
  content: string,
  exists: boolean,
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();
  if (!exists) edit.createFile(uri, { overwrite: false });
  edit.replace(uri, await fullDocumentRange(uri), content);
  return edit;
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
        const choice = await vscode.window.showInformationMessage(
          exists ? `Overwrite ${req.path}?` : `Create ${req.path}?`,
          "Apply",
          "Cancel",
        );
        if (choice !== "Apply") {
          throw new acp.RequestError(
            FS_ERROR_CODE,
            `write_text_file denied by user for ${req.path}`,
          );
        }
        const edit = await buildWriteEdit(uri, req.content, exists);
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
