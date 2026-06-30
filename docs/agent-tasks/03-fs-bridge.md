# Task 03 — `fs` reverse-call bridge

> **Do not rewrite.** Use VS Code's `vscode.workspace.openTextDocument` and
> `vscode.workspace.applyEdit` directly. Do not roll a custom file-IO layer.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/acp-core/src/capabilities/vscodeFsBridge.ts`
- create: `packages/acp-core/src/capabilities/vscodeFsBridge.test.ts`
- edit:   `packages/acp-core/src/client/cliClient.ts` (only to thread the `onReadTextFile` / `onWriteTextFile` handlers into the `ClientSideConnection` constructor — they already exist as a stub in PR 01)
- edit:   `packages/acp-core/src/index.ts` (re-export the bridge factory)

**Forbidden scope**

- `packages/acp-core/src/session/`, `packages/acp-core/src/discovery/`
- `packages/acp-core/src/provider/` (PR 09)
- `packages/claude-config/`, `packages/adapter-claude/`
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map (capabilities row)
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` for `ReadTextFileRequest`, `WriteTextFileRequest`, `ReadTextFileResponse`, `WriteTextFileResponse`
3. VS Code `vscode.workspace.openTextDocument` and `vscode.workspace.applyEdit` APIs

**TDD order (mandatory)**

1. **RED.** Write `vscodeFsBridge.test.ts` with the four tests in §Required tests below. Stub `vscode` via Vitest's `vi.mock("vscode", …)`.
2. **GREEN.** Implement the bridge.
3. **REFACTOR.** No "while I'm here".

**Required tests**

- **`read_text_file` happy path.** A mocked `vscode.workspace.openTextDocument` returns `{ getText: () => "hello" }`. The bridge returns `{ content: "hello" }`.
- **`read_text_file` missing file.** `openTextDocument` throws; the bridge returns a `RequestError` with `code: -32000` and the file path in the message.
- **`write_text_file` happy path.** A mocked `applyEdit` resolves; the bridge returns `{ content: null }` (per the ACP spec, write does not echo).
- **`write_text_file` user-denied.** A mocked `applyEdit` rejects; the bridge returns a `RequestError`.

**Public surface (required)**

```ts
export function makeFsHandlers(): {
  readTextFile: (req: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  writeTextFile: (req: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse>;
};
```

**Behaviour contract (must all hold)**

- `req.path` is interpreted as a workspace-relative path. If the path is absolute, it must be inside a trusted workspace folder; otherwise the bridge returns `RequestError` with a clear message.
- `req.lineStart` / `req.lineCount` are honoured. The bridge returns a substring of `getText()` limited to the requested line range.
- Write requests are *not* silently overwritten. The bridge shows a VS Code confirmation prompt via `vscode.window.showInformationMessage(["Apply", "Cancel"])`; on "Cancel" it returns the same `RequestError` as user-denied.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/capabilities/vscodeFsBridge.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 4 files changed

**Output contract** — same shape as task 01.
