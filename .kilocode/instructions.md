# vscode-model-provider — Kilo Code Review instructions

This file gives Kilo Code (the AI reviewer that comments on PRs) project-specific context. When reviewing a PR, Kilo should read this first, then `docs/lessons-learned.md`, then the contract doc for the subagent the PR is implementing.

## What this project is

A monorepo for an ACP (Agent Client Protocol) provider for VS Code Copilot Chat. Two main surfaces:

- **`apps/extension/`** — thin VS Code shell that registers a `vscode.lm` chat provider for vendor `"acp"` (display name "ACP Model Provider").
- **`packages/acpify/`** — agent-agnostic ACP core (SDK-backed stdio client + persistent session pool + reverse-call bridges).
- **`packages/claude-config/`** + **`packages/claude-acp/`** — Claude-specific config + adapter (skeletons at time of writing).

The architecture is split into 11 numbered subagent PRs (00–11) landing in order. Each subagent PR is implemented via a `PATCHER → VERIFIER → REVIEWER` loop and lands with a `/act` round against AI reviewers (you, CodeRabbit, cubic, Gemini, CodeAnt, Amazon Q, SonarCloud). The contract for each subagent is in `docs/agent-tasks/NN-*.md`.

## Reviewer focus — what to look for

In order of priority:

1. **Settlement contract correctness** (subagent 02 / session pool PRs). `PromptHandle.done` MUST resolve exactly once. Intermediate `agent_message_chunk` updates with no `stopReason` MUST NOT settle `done`. Falsification-trace every new test: write out what the buggy archive implementation would do, and trace whether the new test would catch it. If the answer is "yes, the buggy code would also pass", the test is wrong.

2. **The "Do not rewrite" contract.** Every per-PR task doc opens with a "Do not rewrite" header pointing at an upstream library to reuse. Reject PRs that reimplement what `@agentclientprotocol/sdk` or Node built-ins already do. Examples to watch for: `Readable.toWeb`/`Writable.toWeb` wrapped, JSON-RPC framing reinvented, `child_process.spawn` wrapped.

3. **Public surface must match the contract doc.** Compare the actual `makeFsHandlers()`/`makeTerminalHandlers()`/etc. signature against the one in `docs/agent-tasks/NN-*.md`. Drift = bug. Note that the SDK's type names can be longer than the contract (e.g. `acp.WaitForTerminalExitRequest` vs the contract's shorthand).

4. **Path resolution safety** (subagent 03 / fs bridge PRs). Workspace-relative paths must be post-validated against the workspace folder — `Uri.joinPath` does NOT clamp `..` segments. Absolute paths must be inside a trusted workspace folder. Reject any PR that does `vscode.workspace.openTextDocument(req.path)` without the safety check.

5. **Async RPC correctness.** `void somePromise` is not enough — chain `.catch` to avoid unhandled rejections. Lifecycle callbacks (e.g. `onSessionEvicted`) fire AFTER the inner operation resolves, not before.

## Architectural invariants — never break these

- **No `vscode` import** in `packages/acpify/src/{client,session,discovery}/`. Only `apps/extension`, `packages/acpify/src/capabilities/`, and `packages/acpify/src/provider/` may import `vscode`. The core stays portable.
- **VS Code-coupled bridges go under a sub-entrypoint** (e.g. `@theplenkov/acpify/capabilities/vscodeFsBridge`), not the package root.
- **The `.vsix` is self-contained.** Only `vscode` + Node built-ins may be external. After every PR, run `unzip -p apps/extension/vscode-model-provider-0.2.0.vsix extension/dist/extension.mjs | grep "^import"` and assert: NO `@theplenkov/*` left external.
- **Cross-cutting rules from `docs/lessons-learned.md`** (read this file before reviewing any PR; it has 9 rules with concrete hits).

## The 9 rules (quick reference — see `docs/lessons-learned.md` for full write-ups)

1. **No wall-clock sleeps in tests.** Use deterministic stream-splits or fake timers.
2. **No reimplementing Node built-ins or upstream libs.** Use `Readable.toWeb`/`Writable.toWeb` directly.
3. **A test that doesn't exercise the implementation trivially passes.** Falsification-trace every new test.
4. **Public surface must match the contract doc exactly.**
5. **Lifecycle callbacks fire AFTER the operation they observe.**
6. **Update timestamps on every relevant event** (e.g. `lastUsed` on every chunk in the session pool).
7. **Async RPC rejections must be caught** (`.catch` after `void`).
8. **Keep new files under ~200 LOC** (Rule 14). Split proactively if a file approaches that.
9. **Use a sub-entrypoint for VS Code-coupled bridges** (Rule 15).

## Style preferences

- **Use `Promise.resolve()`-style microtask flushes** instead of `setTimeout(..., N)` in tests.
- **Use `vi.useFakeTimers()` + `vi.advanceTimersByTime(...)`** for idle-eviction tests.
- **Use `vi.mock("vscode", ...)`** to stub the `vscode` module in test files. The test file structure from `vscodeFsBridge.test.ts` is the canonical pattern.
- **Mock factories per-test** in `beforeEach` (e.g. `vi.mocked(vscode.workspace.openTextDocument).mockReset()`) to avoid state leak between tests.
- **Use `as never` for vscode mocks** when passing typed stubs to typed code. Don't fight the types.
- **Use structural duck-typing** (e.g. `interface TextPartLike { readonly value: string }`) instead of `instanceof` for SDK type checks.

## Known false-positive patterns (don't flag these)

- **Non-null assertions in test code** (`expect(x[0]!.toBe(...)`). Vitest tests are throwaway, prioritize clear failure messages over defensive coding.
- **`@typescript-eslint/no-explicit-any` warnings on type-only imports** of `vscode` namespace. The `vscode` module is required as a type at compile time even if its runtime side is mocked.
- **`@typescript-eslint/no-unused-vars` for parameters prefixed with `_`.** Those are intentional "I accept this argument but don't use it" markers. (This is also the linter's default behavior.)
- **Optional chaining on `NodeJS.Timeout.unref()` and similar.** Codacy flags this; it's defensive against older Node runtimes.
- **`process.env["ACP_DEBUG"]` debug logging.** It's intentional, gated by env var, not a security issue.

## When to comment

- **CRITICAL**: bug that crashes or silently misbehaves. E.g., `onSessionCreated` callback that throws.
- **IMPORTANT**: bug that's wrong but doesn't crash. E.g., a callback fired before the operation completes.
- **MINOR**: style, naming, doc drift, future cleanup. Don't block on these.

If the substantive AI reviewers (Kilo, CodeRabbit, cubic, Gemini, CodeAnt) all catch the same issue independently, it's likely real — promote to CRITICAL. If only one reviewer flags something, treat as MINOR and let the human triage.

## After a PR is ready to merge

- Confirm the 5 main CI gates are green: lint, build, typecheck, unit-test, package-vsix.
- External services (CodeScene, Codacy, SonarCloud) are external verdicts; their FAILURE/ACTION_REQUIRED is often opaque from the sandbox. Don't block on these.
- The user squash-merges with `--delete-branch=false`.

## Where to find context

- **`docs/handoff/YYYY-MM-DD-subagent-NN-complete.md`** — the canonical state + lessons per subagent. Read the latest.
- **`docs/lessons-learned.md`** — the 9 cross-cutting rules.
- **`docs/architecture.md`** — the module map + invariants.
- **`docs/specs.md`** — ACP, LMCP, Claude Code references.
- **`docs/agent-tasks/NN-*.md`** — the per-subagent contract.
