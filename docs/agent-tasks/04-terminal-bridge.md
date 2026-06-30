# Task 04 — `terminal` reverse-call bridge

**Role:** patcher subagent.

**Allowed scope**

- create: `apps/extension/src/capabilities/vscodeTerminalBridge.ts`
- create: `apps/extension/src/capabilities/vscodeTerminalBridge.test.ts`
- edit:   `apps/extension/src/client/cliClient.ts` (only the constructor parameter list, no behaviour change)

**Forbidden scope**

- `apps/extension/src/session/`, `apps/extension/src/discovery/`
- `apps/extension/src/provider/`
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` for the 4 terminal methods
3. VS Code `vscode.window.createTerminal`, `vscode.window.onDidCloseTerminal`, `vscode.Terminal.exitStatus`

**TDD order (mandatory)**

1. **RED.** Write `vscodeTerminalBridge.test.ts` with the five tests in §Required tests below.
2. **GREEN.** Implement.
3. **REFACTOR.**

**Required tests**

- **`create` round-trip.** `createTerminal` returns a mock `Terminal` with an id; the bridge returns `{ terminalId }`.
- **`output` echo.** `output` writes the bytes via `terminal.sendText`; the bridge returns the new output buffer.
- **`wait_for_exit` resolves on close.** The mock terminal fires `onDidCloseTerminal` with exit code 0; the bridge resolves `{ exitCode: 0 }`.
- **`wait_for_exit` cancelled.** A pre-aborted `AbortSignal` makes the bridge reject with `AbortError` and never resolve.
- **`release` disposes.** After `release`, the same `terminalId` is not reusable; a second `output` for it returns `RequestError`.

**Public surface (required)**

```ts
export function makeTerminalHandlers(): {
  create: (req: acp.CreateTerminalRequest) => Promise<acp.CreateTerminalResponse>;
  output: (req: acp.TerminalOutputRequest) => Promise<acp.TerminalOutputResponse>;
  waitForExit: (req: acp.WaitForExitRequest, signal?: AbortSignal) => Promise<acp.WaitForExitResponse>;
  release: (req: acp.ReleaseTerminalRequest) => Promise<acp.ReleaseTerminalResponse>;
};
```

**Behaviour contract**

- The bridge keeps an in-memory `Map<terminalId, vscode.Terminal>`. On extension `deactivate`, all live terminals are disposed.
- `create` accepts an optional `env` map; the bridge forwards it via `vscode.EnvironmentVariableCollection` on the workspace.
- `output` does **not** allow raw ANSI control codes (only `\n`, `\r`, `\t`).

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/capabilities/vscodeTerminalBridge.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 4 files changed

**Output contract** — same shape as task 01.
