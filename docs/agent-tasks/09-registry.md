# Task 09 — Registry: real `AcpModelProvider` over `SessionPool`

> **Do not rewrite.** The provider is a thin wrapper over the `SessionPool`
> from PR 02 and the discovery layer from PR 07. No new business logic —
> just mapping ACP types to `vscode.LanguageModel*`.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/acp-core/src/provider/{acpProvider.ts,modelInfo.ts,acpProvider.test.ts}`
- delete: `packages/acp-core/src/provider/barebone.ts`, `packages/acp-core/src/provider/barebone.test.ts` (this PR's barebone)
- edit:   `apps/extension/src/extension.ts` (only the construction wiring; do not change activation events)
- edit:   `packages/acp-core/src/index.ts` (export `AcpModelProvider` instead of `AcpBareboneProvider`)
- edit:   `packages/acp-core/src/provider/barebone.ts` — DELETE; superseded by `acpProvider.ts`

**Forbidden scope**

- `packages/acp-core/src/session/` (read-only), `packages/acp-core/src/capabilities/`, `packages/acp-core/src/discovery/`
- `packages/claude-config/`, `packages/adapter-claude/`
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map
2. `docs/specs.md` §`vscode.lm.registerLanguageModelChatProvider`
3. PR 02's `SessionPool` API
4. PR 07's `discover()` and `BUILTIN_ADAPTERS`

**TDD order (mandatory)**

1. **RED.** Write `acpProvider.test.ts` with the four tests below.
2. **GREEN.** Implement.
3. **REFACTOR.**

**Required tests**

- **One model per discovered agent.** Given a fake `SessionPool` that reports one connected `AcpSession` with one model, `provideLanguageModelChatInformation` returns one `LanguageModelChatInformation` whose `id` is `<agent>:<model>`.
- **Model ID format is stable.** Two agents each with a model called `claude-3-5-sonnet-20241022` produce two distinct IDs (`claude-code:claude-3-5-sonnet-20241022` vs `gemini-cli:claude-3-5-sonnet-20241022`).
- **Streaming a prompt translates `session/update` to `progress.report`.** A fake session that emits text chunks and a tool_call; the test asserts `progress.report` is called with `LanguageModelTextPart` and `LanguageModelToolCallPart` in order.
- **Cancellation maps `token.onCancellationRequested` to `session/cancel`.** The test calls the cancellation callback; the fake session's `cancel()` is invoked.

**Public surface**

```ts
// acpProvider.ts
export class AcpModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  constructor(pool: SessionPool, prefix?: string);
  provideLanguageModelChatInformation(opts, token): ProviderResult<…[]>;
  provideLanguageModelChatResponse(model, messages, opts, progress, token): Thenable<void>;
  provideTokenCount(model, text, token): Thenable<number>;
}
```

**Settlement (re-stated; this PR is where it becomes user-visible)**

`provideLanguageModelChatResponse` returns *exactly when* the
`AcpSession.prompt(prompt).done` promise resolves. It does **not**
return after the first text chunk (the bug in
`archive/pre-refactor-2026-06-30` `acpProvider.ts:139`) and it does
**not** return after a 10-second timer (the bug in
`acpProvider.ts:148`).

**Mapping rules**

- `acp.ContentPart { type: "text" }` → `vscode.LanguageModelTextPart`
- `acp.ContentPart { type: "image" }` → `vscode.LanguageModelDataPart(mime)`
- `acp.ToolCall` (kind from `tool_call` update) → `vscode.LanguageModelToolCallPart(id, name, input)`
- `acp.ToolCallUpdate.content` → `LanguageModelTextPart` / `LanguageModelDataPart`
- `vscode.LanguageModelToolResultPart` in the incoming messages is dropped here; PR 02's session pool feeds it back into the next prompt as a `tool_result` block.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/provider/acpProvider.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 8 files changed
- The old `apps/extension/src/provider.ts` and `provider.test.ts` are gone

**Output contract** — same shape as task 01.
