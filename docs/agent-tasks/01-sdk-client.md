# Task 01 — Switch to official `@agentclientprotocol/sdk` client

> **Do not rewrite.** Use the SDK's `ClientSideConnection`, `ndJsonStream`,
> and typed notifications directly. Do not reimplement JSON-RPC framing
> (NDJSON line splitter, request/response correlation, notification dispatch).
> The previous `acp/client.ts` in `archive/pre-refactor-2026-06-30` does all
> of that wrong and is the file this PR deletes.

**Role:** patcher subagent. Produce a diff that the verifier subagent will
typecheck and run vitest against. You do not run the tests yourself.

**Allowed scope**

- create: `packages/acp-core/src/client/{cliClient.ts,streamBridge.ts,cliClient.test.ts}`
- create: `apps/extension/test/fixtures/fakeAcpAgent.ts` is **out of scope** (PR 08) but `cliClient.test.ts` may inline a tiny fake if needed
- delete: `packages/acp-core/src/provider/barebone.ts` (this PR), `packages/acp-core/src/provider/barebone.test.ts` (the barebone)
- edit:   `apps/extension/src/extension.ts` (only the import + the new provider wiring)
- edit:   `packages/acp-core/package.json` (add `@agentclientprotocol/sdk` to dependencies)
- edit:   `apps/extension/package.json` (only `dependencies` to confirm the workspace dep on `@theplenkov/acp-core` is correct)

**Forbidden scope**

- `packages/acp-core/src/session/`, `packages/acp-core/src/capabilities/`, `packages/acp-core/src/discovery/`
- `packages/claude-config/`, `packages/adapter-claude/`
- `tests/fixtures/` (PR 08)
- `nx.json`, root `package.json`, `.github/workflows/*`
- `docs/`

**Reference (read in this order, every one of them, before writing a line of code)**

1. `docs/architecture.md` §Module map + §Data flow
2. `docs/specs.md` §ACP v1, §`@agentclientprotocol/sdk` schema
3. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` — the real API surface
4. `node_modules/@agentclientprotocol/sdk/dist/connection/*` — how the SDK wires `ClientSideConnection`

**TDD order (mandatory)**

1. **RED.**  Write `cliClient.test.ts` with the three tests in §Required tests below. Run `cd apps/extension && npx vitest run src/client/cliClient.test.ts`. It must fail with **module not found**, not with a typo in the test.
2. **GREEN.** Write `cliClient.ts` and `streamBridge.ts`. Tests must pass.
3. **REFACTOR.** Tighten types. No "while I'm here" changes. Do not touch `extension.ts` beyond the import swap.

**Required tests in `cliClient.test.ts`**

- **NDJSON framing.** A `Readable` that emits two valid JSON-RPC lines and a truncated third; the parser must resolve with the two parsed messages and keep the partial in its buffer until the rest arrives.
- **Reverse-call dispatch.** A fake agent that sends a `session/update` notification: `onSessionUpdate` must receive the typed payload.
- **Reverse-call round-trip.** A fake agent that requests `fs/read_text_file`: `onReadTextFile` must be called and the response must be written back to the stream in a valid JSON-RPC frame that the fake agent parses.

**`CliAcpClient` public surface (required)**

```ts
export interface CliClientHandlers {
  onSessionUpdate: (n: acp.SessionNotification) => void;
  onReadTextFile: (req: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  onWriteTextFile: (req: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse>;
  onCreateTerminal: (req: acp.CreateTerminalRequest) => Promise<acp.CreateTerminalResponse>;
  onTerminalOutput: (req: acp.TerminalOutputRequest) => Promise<acp.TerminalOutputResponse>;
  onWaitForExit: (req: acp.WaitForExitRequest, signal?: AbortSignal) => Promise<acp.WaitForExitResponse>;
  onReleaseTerminal: (req: acp.ReleaseTerminalRequest) => Promise<acp.ReleaseTerminalResponse>;
  onRequestPermission: (req: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse>;
  onElicitation?: (req: acp.CreateElicitationRequest, signal?: AbortSignal) => Promise<acp.CreateElicitationResponse>;
}

export class CliAcpClient {
  connect(cmd: string, args: string[], handlers: CliClientHandlers, clientInfo: acp.ClientInfo, options?: { env?: NodeJS.ProcessEnv }): Promise<acp.InitializeResponse>;
  sessionNew(p: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  sessionLoad(p: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse>;
  sessionPrompt(p: acp.PromptRequest): Promise<acp.PromptResponse>;
  sessionCancel(p: { sessionId: string }): void;
  sessionList(p: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse>;
  sessionSetMode(p: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse>;
  sessionSetModel(p: acp.SetSessionModelRequest): Promise<acp.SetSessionModelResponse>;
  disconnect(): Promise<void>;
  get isConnected(): boolean;
}
```

`extension.ts` after this PR must instantiate `CliAcpClient` and pass it
no-op handlers for every capability that does not yet have a bridge
(PRs 03–06). The exception is `onSessionUpdate`, which logs to the
output channel for now; PR 02 replaces that with the session pool.

**Success criteria (all must hold)**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/client/cliClient.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 8 files changed
- `apps/extension/src/provider.ts` and `provider.test.ts` are gone
- `extension.ts` does not import `./provider.js`; it imports `./client/cliClient.js`

**Output contract** — return, in this exact order:

```
status: done | stuck | failed
summary: 5 lines max
diff: git diff --stat base/barebone..HEAD
tsc output: full stdout + exit code
vitest output: full stdout + exit code
deviations: list, with rationale, or "none"
```
