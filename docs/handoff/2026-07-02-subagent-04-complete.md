# Handoff — 2026-07-02: end of subagent 04

> **For the next agent.** Read this first. PR #5 is merged; you pick
> up subagent 05. The repo has 5 merged PRs and 6 to go.

---

## 1. TL;DR

`main` is at **commit `<squash of PR #5>`** (terminal bridge). Five
PRs merged so far:

| PR | Title | Date |
|----|-------|------|
| #1 | chore: revert to barebone foundation | 2026-06-30 |
| #2 | feat(acpify): SDK-backed CliAcpClient | 2026-06-30 |
| #3 | feat(acpify): persistent per-(agent,cwd) session pool | 2026-07-01 |
| #4 | feat(acpify): fs reverse-call bridge | 2026-07-02 |
| **#5** | **feat(acpify): terminal reverse-call bridge (subagent 04)** | **2026-07-02** |

**Next task: subagent 05 = `docs/agent-tasks/05-permission-bridge.md`**
(`session/request_permission` bridge + persistent rule store +
`globalState` wiring).

Subagents 06–11 sequenced after #5 in the order the docs are numbered.

---

## 2. State

### What is on `main`

The terminal bridge is in `@theplenkov/acpify/capabilities/vscodeTerminalBridge`
(sub-entrypoint, Rule 15). It implements the four `terminal/*` handlers
on top of `vscode.window.createTerminal` + `vscode.window.onDidCloseTerminal`.
The bridge:

- Generates a monotonic `terminalId` per `create` and stashes the
  `vscode.Terminal` in an internal `Map<terminalId, vscode.Terminal>`.
- Looks up by `terminalId` on every subsequent call; missing id → throw
  `acp.RequestError(-32000)`.
- `waitForExit` honours an optional `AbortSignal` — pre-aborted rejects
  with `RequestError`, mid-wait abort disposes the listener and rejects.
- `output` sanitises raw C0 control bytes (the contract's "no raw ANSI"
  clause) before calling `terminal.sendText`.
- Releases and disposes terminals on `release`; never holds a terminal
  past release.

### Test count (after PR #5)

```
 4 tests — packages/acpify/src/provider/barebone.test.ts
 3 tests — packages/acpify/src/client/cliClient.test.ts
 6 tests — packages/acpify/src/session/session.test.ts
 8 tests — packages/acpify/src/capabilities/vscodeFsBridge.test.ts
 5 tests — packages/acpify/src/capabilities/vscodeTerminalBridge.test.ts  ← NEW
26 tests total across @theplenkov/acpify (21 prior + 5 new).
```

### Repo shape

```
packages/acpify/src/
├── capabilities/
│   ├── vscodeFsBridge.ts                    (PR 04, 257 LOC — at CodeScene edge)
│   ├── vscodeFsBridge.test.ts               (PR 04)
│   ├── vscodeTerminalBridge.ts              (PR 05, 170 LOC)
│   ├── vscodeTerminalBridge.helpers.ts      (PR 05, 51 LOC — Rule 14 split)
│   └── vscodeTerminalBridge.test.ts         (PR 05, 211 LOC)
├── client/cliClient.ts                      (terminal handlers already wired PR 02)
└── session/permissions.ts                   (PR 02 in-memory store, no changes in #5)
```

### CI state on main

5 main gates SUCCESS. SonarCloud PASSED. Codacy + CodeScene remain
opaque (authrestricted); see handoff #3 for the proactive file-split
that kept CodeScene happy on PR #5.

---

## 3. What landed in PR #5 (subagent 04)

- `packages/acpify/src/capabilities/vscodeTerminalBridge.ts` (170 LOC) —
  public surface `makeTerminalHandlers()` returning the four handlers.
- `packages/acpify/src/capabilities/vscodeTerminalBridge.helpers.ts`
  (51 LOC) — extracted `termError`, `sanitiseOutput`, `envArrayToRecord`.
- `packages/acpify/src/capabilities/vscodeTerminalBridge.test.ts` (5 tests) —
  create round-trip, output echo (with falsification trace), wait_for_exit
  resolves, wait_for_exit cancelled, release idempotence.
- `packages/acpify/tsdown.config.ts` — added sub-entrypoint.
- `packages/acpify/package.json` — added `./capabilities/vscodeTerminalBridge`
  to the `exports` map.
- `packages/acpify/src/index.ts` — added a one-line comment pointing
  consumers to the sub-entrypoint (no re-export, Rule 15).

### Deviation from the contract doc (documented per Rule 4)

The contract doc `docs/agent-tasks/04-terminal-bridge.md` and the
RED-phase test scaffold it shipped both contained type names the SDK
does not export:

- `acp.WaitForExitRequest` / `acp.WaitForExitResponse` → the SDK
  exposes these as `acp.WaitForTerminalExitRequest` /
  `acp.WaitForTerminalExitResponse`. The bridge and the test use the
  SDK's actual names. Documented here; the contract doc is in
  `forbidden scope` for this PR, so it was not edited.
- `CreateTerminalRequest` has no `name` field — the bridge uses
  `req.command` as the VS Code `TerminalOptions.name` for the display.
  The test was tightened from `{ name: "..." }` to `{ command: "..." }`.
- `TerminalOutputRequest` has no `data` field. The contract's
  "`output` writes via `terminal.sendText`" claim is honoured by
  reading an extension field (`(req as unknown as { data?: string }).data`)
  inside the bridge; the test passes the same cast. The bridge's
  `terminal_output` handler is the only opportunity to write to the
  embedded terminal because the SDK does not provide a separate
  write method.
- Falsification trace for the "output echo" test: a buggy impl that
  skipped `sendText` entirely would still satisfy `resp.output === ""`,
  so the test additionally asserts the captured `sendText` payload
  (Rule 3, lessons-learned).

### New patterns from PR #5 (worth carrying forward)

1. **Proactive file-split for the ~200 LOC budget.** The initial
   implementation was 209 LOC. Per Rule 14 (lessons-learned), the
   next round split helpers into `vscodeTerminalBridge.helpers.ts`
   (51 LOC) and shrank the main file to 170 LOC. Future agents
   should split proactively before CodeScene flags it. The split
   is one-line (`import { … } from "./…helpers.js"`) so it's cheap.
2. **SDK type names win over contract-doc aliases.** The contract
   doc had two non-existent type names. The PATCHER picked the SDK
   names and documented the deviation. Subagent 05's contract doc
   should be sanity-checked for the same issue before dispatch.
3. **Reference-equality for `onDidCloseTerminal` filtering.** The
   bridge's `waitForExit` compares the closing terminal to the
   stashed one by `===`. The test had to mock `createTerminal` to
   return the SAME object that the close event fires with — otherwise
   the bridge silently rejects. Subagent 05's permission bridge
   should not need this pattern, but if it does: capture the object
   in the test before firing the event.

---

## 4. Lessons learned (delta from subagents 00–03)

Two new rules, both from the contract-vs-SDK mismatch above. Recorded
in the next round of `docs/lessons-learned.md`:

- **Rule 16 (NEW). Sanity-check contract-doc type names against the
  installed SDK before scaffolding tests.** The contract doc listed
  `acp.WaitForExitRequest` which the SDK does not export. The RED
  scaffold was uncompilable until it was tightened. Sanity check:
  `grep -E "type|interface" node_modules/@agentclientprotocol/sdk/dist/schema/index.d.ts | grep -i "wait\|terminal"`.
- **Rule 17 (NEW). When a contract clause is internally inconsistent
  with the SDK, pick the SDK interpretation and document.** Rule 4
  already says "public surface must match the contract doc exactly";
  Rule 17 refines: when the contract doc contradicts the SDK, the
  SDK wins. Document the deviation in the handoff and (if scope
  allows) the contract doc itself.

Plus the existing rules that fired on PR #5:

- **Rule 1 (no wall-clock sleeps):** the `wait_for_exit resolves` test
  drives the close event synchronously through a captured listener
  reference. No `setTimeout`, no `vi.useFakeTimers()`.
- **Rule 3 (falsification trace):** the `output echo` test asserts the
  captured `sendText` payload in addition to the response shape, so a
  buggy impl that skips `sendText` is caught.
- **Rule 7 (catch RPC errors):** every bridge handler wraps internal
  throws via `termError()` and re-throws as `RequestError(-32000)`.
  Already-formed `RequestError`s are re-thrown as-is.
- **Rule 14 (file-size):** helpers split out at 51 LOC, main file at
  170 LOC. CodeScene budget respected.
- **Rule 15 (sub-entrypoint):** `vscodeTerminalBridge` reachable only
  via `@theplenkov/acpify/capabilities/vscodeTerminalBridge`. Listed
  in `package.json` `exports` and `tsdown.config.ts` `entry`. The
  package root does not re-export it.

---

## 5. The subagent loop — operational contract (unchanged)

For each new subagent task:

1. **Create a branch off `main`.** `git fetch origin main && git checkout -b task/NN-task-name origin/main`. Same naming convention.
2. **Dispatch the PATCHER.** Single subagent with a focused `SUBAGENT_CONTEXT_CAPSULE` containing: exact files in scope, exact files forbidden, TDD order, success criteria, reference docs to read first.
3. **Verify locally.** `cd packages/acpify && npx tsc --noEmit -p tsconfig.json && npx vitest run` then `npm run build -ws` then `cd apps/extension && npx @vscode/vsce package --no-dependencies`. All must be green.
4. **Dispatch the REVIEWER.** Severity-labelled findings, contract-compliance checks, codehome + minimal-root-cause lens.
5. **Iterate PATCHER on REVIEWER's CRITICAL/IMPORTANT.** Loop until CLEAN or MINOR-only.
6. **Commit + push + open PR.** PR title `feat(acpify): <task-name>`. Subagent 05's PR title: `feat(acpify): permission reverse-call bridge + persistent rule store`.
7. **`/act` on the opened PR.** Substantively reply + resolve per thread. Loop on IMPORTANT/CRITICAL findings.
8. **Squash-merge to main.** `--delete-branch=false`.

The PATCHER does NOT commit. Reviewer verifies. You (general) commit and push.

---

## 6. Plan: subagent 05 — `permission` bridge

**Contract:** `docs/agent-tasks/05-permission-bridge.md`.

**Goal:** Add `vscodePermissionBridge.ts` + test under
`packages/acpify/src/capabilities/`. Implements
`session/request_permission` reverse-call:

- `requestPermission(req, signal?)`: if `PermissionStore.match`
  returns `"allow"` or `"deny"`, short-circuit. Otherwise show a
  `vscode.window.showQuickPick` with the request's `options` plus
  two sentinel options `__allow_always` and `__deny_always`. On a
  pick, optionally persist a new `PermissionRule` to the store and
  return `{ outcome: { outcome: "selected", optionId } }`. On
  cancel: `{ outcome: { outcome: "cancelled" } }`.

**Important context the next agent MUST know:**

- **TDD**: write failing test FIRST, assert it fails with `module not found`,
  THEN write the implementation. Same as subagent 04.
- **Files**:
  ```
  packages/acpify/src/capabilities/vscodePermissionBridge.ts
  packages/acpify/src/capabilities/vscodePermissionBridge.test.ts
  packages/acpify/src/capabilities/vscodePermissionBridge.helpers.ts (if needed for Rule 14)
  ```
  Edit `packages/acpify/src/index.ts` (re-export comment) and
  `packages/acpify/src/client/cliClient.ts` if the `requestPermission`
  handler is not yet wired into the SDK adapter (verify first — it
  is in the existing `CliClientHandlers` interface, so the SDK
  adapter is already wired; no edit needed).
- **PermissionStore already exists** at
  `packages/acpify/src/session/permissions.ts` (PR 02). It has
  `load(scope)`, `save(scope, rules)`, `match(tool, input)`. Use as-is.
- **Allowed scope per contract**: 5 files. The success-criteria line
  `git diff --stat base/barebone..HEAD` in the contract is wrong (same
  bug as subagent 04's contract); use `main..HEAD`.
- **Public surface**:
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
- **Test infrastructure**: mock `vscode` via `vi.mock("vscode", ...)`.
  See `packages/acpify/src/capabilities/vscodeFsBridge.test.ts` and
  `vscodeTerminalBridge.test.ts` for the pattern.
- **Sanity-check the contract doc for type-name drift** (Rule 16
  above). The contract names `acp.RequestPermissionRequest` /
  `acp.RequestPermissionResponse` — verify these are the actual SDK
  names before scaffolding the test.
- **File budget**: ≤5 files. Aim for subagent 03's pattern: one main
  file + one test file + helpers file if needed + 1-2 minimal index.ts
  / cliClient.ts edits.
- **Falsification traces** (Rule 3) for every new test:
  - Allow: a buggy impl that always prompts would still return
    `allow` if the user picks it. Trace what happens when the user
    picks `deny` — assert the store match path is exercised.
  - Deny: same — assert the store match short-circuits before any
    UI is shown.
  - Allow-always: assert `store.match` returns the new decision on
    the next call.
  - Cancel: assert no rule is added.

**Allowed scope** (per the contract):

- create: `packages/acpify/src/capabilities/vscodePermissionBridge.ts`
- create: `packages/acpify/src/capabilities/vscodePermissionBridge.test.ts`
- edit:   `packages/acpify/src/session/permissions.ts` (the in-memory store)
- edit:   `packages/acpify/src/client/cliClient.ts` (only the constructor parameter list)
- edit:   `packages/acpify/src/index.ts` (re-export the bridge factory)

**Forbidden scope:**

- `packages/acpify/src/discovery/`, `packages/acpify/src/provider/` (PR 09)
- `packages/claude-config/`, `packages/claude-acp/`
- `tests/fixtures/`
- `docs/`

---

## 7. Plan: subagents 06–11

| # | Task | Depends on |
|---|------|------------|
| 06 | Elicitation bridge (`unstable/create_elicitation`) | PR 02 |
| 07 | PATH scout + builtin adapter table | none |
| 08 | `fakeAcpAgent` stdio fixture + Tier-2 test driver | PR 02 |
| 09 | Registry: real `AcpModelProvider` over `SessionPool` | PR 03 (session pool), PR 07 |
| 10 | api-helper + env injection (rotating key) | PR 07 (adapter), PR 05 (permissions) |
| 11 | CI nightly host-test + README + Tier-3 driver | all above |

After subagent 11 merges, the extension is ready for Marketplace.

---

## 8. Operational notes for the next agent

### Repo state

- **Branch you branch from:** `main` at `<squash of PR #5>`.
- **`task/02..04` still exist on remote** (we used
  `--delete-branch=false` in the squash merges). Doesn't matter — main
  is your base.
- **`base/barebone` is gone** (squash-deleted in PR #1).
- **`task/01-sdk-client` is gone** (squash-deleted in PR #2).

### Fix the contract docs before dispatching

**Important bug in the contract docs (recurring)**: success-criteria
line 67 of `05-permission-bridge.md` says
`git diff --stat base/barebone..HEAD` — wrong. The current base is
`main`. The next agent should fix this in their PATCHER context
capsule to `main..HEAD`.

### Commands

```bash
cd /workspace/.../agent_<your-id>

git fetch origin main
git checkout -b task/05-permission-bridge origin/main
# ... work ...
git add -A && git commit -m "feat(acpify): permission reverse-call bridge + persistent rule store (subagent PR 05)"
git push -u origin task/05-permission-bridge
gh pr create --base main --head task/05-permission-bridge --title "feat(acpify): permission reverse-call bridge + persistent rule store" --body "..."
```

### CI rebuild needed after every dependency change

Always `rm -rf apps/extension/dist packages/*/dist` and rebuild before
verifying — `tsdown` doesn't track transitive dependency changes in
`node_modules`.

### Bundle invariants per PR

After each PR's build, check:

```bash
unzip -p apps/extension/vscode-model-provider-0.2.0.vsix extension/dist/extension.mjs | grep "^import"
# Expect: vscode + a few node: built-ins (child_process, stream). NO @theplenkov/* imports (everything is bundled).
```

---

## 9. End-state summary (for human eyes)

After five merged PRs (one barebone + four subagents), the architecture
is wider:

- **`@theplenkov/acpify`**: `CliAcpClient` + `SessionPool`/`AcpSession`
  + `vscodeFsBridge` (fs/read_text_file, fs/write_text_file) +
  `vscodeTerminalBridge` (terminal/create, terminal/output,
  terminal/wait_for_exit, terminal/release) + `PermissionStore` (in-memory
  + globalState).
- **`@theplenkov/claude-config`**: skeleton; PR 10.
- **`@theplenkov/claude-acp`**: skeleton; PR 07 + PR 10.
- **`apps/extension`**: thin shell, registers LMCP for vendor `acp`,
  constructs `SessionPool`, no-op reverse-call handlers.

What's working: SDK-backed stdio client, persistent per-cwd session
pool with FIFO queue, fs bridge (read/write + path-traversal protection),
terminal bridge (create/output/wait/release with ANSI sanitisation +
abort honouring), in-memory permission store.

What's not yet: permission bridge UI, models exposed, elicitation
bridge, discovery, registry (replaces barebone), api-helper, host test,
marketplace-quality docs.

Six subagents remain, in dependency order: 05 (permission) → 06
(elicitation) → 07 (discovery, can run in parallel with 05–06) → 08
(fake stdio fixture) → 09 (registry, replaces barebone) → 10 (api-helper)
→ 11 (CI nightly, README).

The agent who picks up next: read §1, §3, §5, §6 of this handoff. The
rest of the doc is reference material to have on hand.

---

## 10. File history (for the handoff chain)

- `docs/handoff/2026-06-30-subagent-00-foundation.md` — initial state capture
- `docs/handoff/2026-07-01-subagent-02-complete.md` — handoff for subagent 03 (fs bridge)
- `docs/handoff/2026-07-02-subagent-03-complete.md` — handoff for subagent 04 (terminal bridge)
- `docs/handoff/2026-07-02-subagent-04-complete.md` — this file. Handoff for subagent 05 (permission bridge).
