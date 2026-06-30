# Task 06 — `unstable_createElicitation` bridge

> **Do not rewrite.** Use `vscode.window.showQuickPick` and
> `vscode.window.showInputBox` directly. Do not build a custom multi-step
> form framework.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/acp-core/src/capabilities/vscodeElicitationBridge.ts`
- create: `packages/acp-core/src/capabilities/vscodeElicitationBridge.test.ts`
- edit:   `packages/acp-core/src/client/cliClient.ts` (only the constructor parameter list)
- edit:   `packages/acp-core/src/index.ts` (re-export the bridge factory)

**Forbidden scope**

- `packages/acp-core/src/session/`, `packages/acp-core/src/discovery/`
- `packages/acp-core/src/provider/` (PR 09)
- `packages/claude-config/`, `packages/adapter-claude/`
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` for `CreateElicitationRequest`, `CreateElicitationResponse`
3. VS Code `vscode.window.showQuickPick` (multi-select for the question pattern)

**TDD order (mandatory)**

1. **RED.** Four tests.
2. **GREEN.**
3. **REFACTOR.**

**Required tests**

- **Single question, single-select, user picks an option.** The bridge returns `{ action: "accept", content: { answer: "<option label>" } }`.
- **Multi-question, user accepts all.** The bridge returns `{ action: "accept", content: { "<q1>": "<a1>", "<q2>": "<a2>" } }`.
- **User dismisses the quickpick.** The bridge returns `{ action: "cancel" }`.
- **Aborted `AbortSignal`.** The bridge returns `{ action: "cancel" }` without showing UI.

**Public surface**

```ts
export function makeElicitationHandlers(): {
  create: (req: acp.CreateElicitationRequest, signal?: AbortSignal) => Promise<acp.CreateElicitationResponse>;
};
```

**Behaviour contract**

- `req.message` is rendered as the quickpick title. `req.options` is the list of choices.
- Multi-question elicitation renders one quickpick at a time, in order, with a breadcrumb in the placeholder (`"[1/N] …"`).
- An empty `req.options` array is treated as a free-text input via `vscode.window.showInputBox`.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/capabilities/vscodeElicitationBridge.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 4 files changed

**Output contract** — same shape as task 01.
