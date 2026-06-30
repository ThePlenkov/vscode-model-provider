# Task 02 — Persistent session pool + FIFO queue

**Role:** patcher subagent.

**Allowed scope**

- create: `apps/extension/src/session/{sessionPool.ts,acpSession.ts,permissions.ts,session.test.ts}`
- edit:   `apps/extension/src/client/cliClient.ts` (only if a typed `getStatus()` accessor is needed; do not re-shape its public API)
- edit:   `apps/extension/src/extension.ts` (only to construct the `SessionPool` and hand it to the provider stub)

**Forbidden scope**

- `apps/extension/src/capabilities/`, `apps/extension/src/discovery/`
- `apps/extension/src/provider/`
- `tests/fixtures/`
- `docs/` (except reading)

**Reference**

1. `docs/architecture.md` §Module map
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts`
3. `github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts` — the `runConsumer` loop is the blueprint; adapt it, do not copy it

**TDD order (mandatory)**

1. **RED.** Write `session.test.ts` with the four tests in §Required tests below.
2. **GREEN.** Write `acpSession.ts`, `sessionPool.ts`, `permissions.ts`.
3. **REFACTOR.** Only with tests green. No "while I'm here" changes.

**Required tests in `session.test.ts`**

- **Settlement on `end_of_turn`.** A fake `CliAcpClient` streams text, then a `session/update` with `sessionUpdate === "agent_message_chunk"` and `stopReason === "end_turn"`. The `prompt()` promise resolves with `{ stopReason: "end_turn" }`.
- **FIFO queue.** Two `prompt()` calls on the same session. The fake client asserts they are written to the child's stdin in order, and the second's settlement happens *after* the first's.
- **Cancellation.** `prompt()` then `promptHandle.cancel()`. The fake client must receive a `session/cancel` JSON-RPC notification before 1 s elapses.
- **Idle eviction.** After a configurable idle timeout (default 5 min in test, 30 min in prod), an unused session's `CliAcpClient.disconnect()` is called.

**Public surface (required)**

```ts
// sessionPool.ts
export interface SessionPoolOptions {
  idleEvictMs?: number;       // default 30 * 60_000
  onSessionCreated?: (sessionId: string) => void;
  onSessionEvicted?: (sessionId: string, reason: "idle" | "error") => void;
}

export class SessionPool {
  constructor(clientFactory: () => CliAcpClient, options?: SessionPoolOptions);
  /** Get or create the session for (agent, cwd). FIFO queue per session. */
  getOrCreate(key: SessionKey): Promise<AcpSession>;
  /** All currently-alive sessions. */
  list(): AcpSession[];
  /** Force-disconnect everything. */
  shutdownAll(): Promise<void>;
}

export interface SessionKey { agentId: string; cwd: string; }

// acpSession.ts
export class AcpSession {
  readonly key: SessionKey;
  readonly sessionId: string;
  prompt(parts: acp.ContentPart[]): PromptHandle;
  cancel(): void;
  disconnect(): Promise<void>;
  get lastUsed(): number;
}

export class PromptHandle {
  readonly done: Promise<acp.PromptResponse>;
  cancel(): void;
}

// permissions.ts
export class PermissionStore {
  load(scope: vscode.ExtensionContext): Promise<PermissionRule[]>;
  save(scope: vscode.ExtensionContext, rules: PermissionRule[]): Promise<void>;
  /** Returns "allow" | "deny" | undefined (no rule). */
  match(tool: string, input: unknown): "allow" | "deny" | undefined;
}
export type PermissionRule = { tool: string; pattern?: string; decision: "allow" | "deny" };
```

**Settlement rule (the contract every other PR depends on)**

`PromptHandle.done` resolves exactly once, on the **first** of:

- `agent_message_chunk` with `stopReason ∈ {"end_turn","refusal","max_tokens"}`
- a `session/end` notification
- an inbound JSON-RPC error
- `cancel()` is called and the agent answers with `{ stopReason: "cancelled" }`
- the underlying child process exits before any of the above

Settlement must *not* be triggered by intermediate `agent_message_chunk`
updates with no stopReason (i.e. "continued"). The current code in
`archive/pre-refactor-2026-06-30` `acpProvider.ts:139` is the bug
this PR fixes.

**`extension.ts` after this PR**

The barebone provider stays in `provider.ts`; the wiring change is in
`extension.ts` only: construct one `SessionPool`, dispose on
`deactivate`. PR 09 replaces the provider with one that calls
`sessionPool.list()` for `provideLanguageModelChatInformation`.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/session/session.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 12 files changed

**Output contract** — same shape as task 01.
