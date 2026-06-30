# Task 05 — `request_permission` bridge + persistent rule store

> **Do not rewrite.** Use `vscode.window.showInformationMessage` and
> `vscode.window.showQuickPick` directly. Do not build a custom permission
> UI framework.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/acp-core/src/capabilities/vscodePermissionBridge.ts`
- create: `packages/acp-core/src/capabilities/vscodePermissionBridge.test.ts`
- edit:   `packages/acp-core/src/session/permissions.ts` (the in-memory store; PR 02 already created the type)
- edit:   `packages/acp-core/src/client/cliClient.ts` (only the constructor parameter list)
- edit:   `packages/acp-core/src/index.ts` (re-export the bridge factory)

**Forbidden scope**

- `packages/acp-core/src/discovery/`, `packages/acp-core/src/provider/` (PR 09)
- `packages/claude-config/`, `packages/adapter-claude/`
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` for `RequestPermissionRequest`, `RequestPermissionResponse`
3. VS Code `vscode.window.showInformationMessage` and `showQuickPick`

**TDD order (mandatory)**

1. **RED.** Write `vscodePermissionBridge.test.ts` with the four tests below.
2. **GREEN.** Implement.
3. **REFACTOR.**

**Required tests**

- **Allow.** `PermissionStore.match` returns `"allow"`. The bridge short-circuits and returns `{ outcome: { outcome: "selected", optionId: "allow" } }` without showing a UI prompt.
- **Deny.** `match` returns `"deny"`. Bridge returns `{ outcome: { outcome: "selected", optionId: "deny" } }`.
- **No rule, user picks "Allow always".** Bridge shows quickpick with the option labels and an "Allow always" option; on that pick, the store gains a new rule and the response is `allow`.
- **No rule, user cancels.** Bridge returns `{ outcome: { outcome: "cancelled" } }`.

**Public surface (required)**

```ts
export function makePermissionHandlers(
  store: PermissionStore,
  scope: vscode.ExtensionContext,
): {
  requestPermission: (
    req: acp.RequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>;
};
```

**Behaviour contract**

- The bridge builds the `optionId`s from the request's `options` array, plus two sentinel options: `__allow_always` and `__deny_always`. Their semantics are stored as a `PermissionRule` in the store and consulted on subsequent calls.
- The bridge honours an aborted `AbortSignal` by returning `{ outcome: { outcome: "cancelled" } }` and **not** showing the quickpick.
- `PermissionStore` persists to `globalState` under key `"acp.permissionRules"`. The store is loaded once on `activate`.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/capabilities/vscodePermissionBridge.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 5 files changed

**Output contract** — same shape as task 01.
