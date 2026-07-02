# Handoff — 2026-07-02: end of subagent 03

> **For the next agent.** Read this first. PR #4 is merged; you
> pick up subagent 04. The repo has 4 merged PRs and 7 to go.

---

## 1. TL;DR

`main` is at **commit `1a27b4f`** (squash-merge of subagent PR #4 =
fs reverse-call bridge). Four PRs merged so far:

| PR | Title | Commit | Date |
|----|-------|--------|------|
| #1 | chore: revert to barebone foundation | `ed3c3bf` | 2026-06-30 |
| #2 | feat(acpify): SDK-backed CliAcpClient | `395705c` | 2026-06-30 |
| #3 | feat(acpify): persistent per-(agent,cwd) session pool | `b1df466` | 2026-07-01 |
| **#4** | **feat(acpify): fs reverse-call bridge (subagent 03)** | **`1a27b4f`** | **2026-07-02** |

**Next task: subagent 04 = `docs/agent-tasks/04-terminal-bridge.md`** (4 reverse-call handlers for `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/release`).

Subagents 05–11 sequenced after #4 in the order the docs are numbered.

---

## 2. State

### What is on `main`

```
1a27b4f feat(acpify): fs reverse-call bridge (subagent PR 03)  ← HEAD
b1df466 feat(acpify): persistent per-(agent,cwd) session pool
395705c feat(acpify): SDK-backed CliAcpClient
ed3c3bf Merge pull request #1 from ThePlenkov/base/barebone
8cc5564 fix(barebone): address second round of cubic review threads
65b3a31 fix(barebone): address AI reviewer threads + fix CI typecheck
308b9b7 refactor: rename packages for clarity (acpify, claude-acp)
3a5ae83 chore(barebone): split core into independent packages + working CI
e881fd2 chore: revert to barebone foundation with architecture docs
```

### Repo shape

```
vscode-model-provider/
├── apps/extension/                              # thin VS Code shell (~30 LOC main file)
├── packages/
│   ├── acpify/                                 # @theplenkov/acpify (agent-agnostic ACP core)
│   │   └── src/
│   │       ├── client/                          # CliAcpClient (PR 02)
│   │       ├── session/                         # SessionPool + AcpSession (PR 03)
│   │       ├── capabilities/                    # reverse-call bridges (PR 03/04/05/06)
│   │       │   └── vscodeFsBridge.ts            # fs/read_text_file, fs/write_text_file (PR 04)
│   │       └── provider/barebone.ts             # (temporary — deleted in PR 09)
│   ├── claude-config/                           # skeleton
│   └── adapter-claude/                          # skeleton
├── docs/
│   ├── architecture.md                          # module map + invariants
│   ├── specs.md                                 # ACP, LMCP, Claude Code refs (updated PR 03 handoff)
│   ├── agent-tasks/01..11.md                    # per-subagent contracts
│   ├── lessons-learned.md                       # 7 cross-cutting rules + 6 procedural
│   └── handoff/                                 # THIS DIRECTORY (full history of handoffs)
└── .github/workflows/ci.yml                     # 5-gate CI
```

### Test count (after PR #4)

```
4 tests  — packages/acpify/src/provider/barebone.test.ts  (AcpBareboneProvider — deleted by PR 09)
3 tests  — packages/acpify/src/client/cliClient.test.ts    (NDJSON framing, reverse-call dispatch, round-trip)
6 tests  — packages/acpify/src/session/session.test.ts     (settlement, FIFO, cancel, cancelled-queue,
                                                           idle eviction, long-prompt lastUsed)
8 tests  — packages/acpify/src/capabilities/vscodeFsBridge.test.ts
                                                          (read happy, read missing, write success,
                                                           write denied, line/limit, outside-workspace,
                                                           traversal escape, create-new-file)
21 tests total across @theplenkov/acpify.
```

### CI state on main

All 5 main gates SUCCESS. SonarCloud PASSED. Codacy + CodeScene remain
opaque FAILURE/ACTION_REQUIRED (authrestricted). The next agent
addressed CodeScene on PR #4 by file-splitting + helper extraction —
see "New patterns from PR #4" below.

---

## 3. What landed in PR #4 (subagent 03)

- `packages/acpify/src/capabilities/vscodeFsBridge.ts` — reverse-call handlers for `fs/read_text_file` and `fs/write_text_file`. Built directly on `vscode.workspace.openTextDocument` and `vscode.workspace.applyEdit`. Path-traversal protection (`Uri.joinPath` doesn't clamp `..`; the bridge re-validates post-join). Line/limit slicing via `doc.lineAt()` (no full-document `getText()` buffering). Write prompts with `vscode.window.showInformationMessage` and `WorkspaceEdit.createFile` for new files.
- 8 tests covering: happy path, missing file, write success, write denied, line/limit, outside-workspace, traversal escape, create-new-file.
- 4 review rounds (1 PATCHER + 2 PATCHER/REVIEWER + 1 fix + 1 split) totaling 10 commits.

### New patterns from PR #4 (worth carrying forward to subagents 04–11)

1. **File-split for CodeScene compliance.** When CodeScene flags a file as too complex (after a +1058-line round), the next agent split the implementation file AND extracted helpers into separate files, which dropped CodeScene complexity flags. **Rule for subagents 04–11: keep new files under ~200 LOC, split proactively if a file is approaching that.**
2. **Sub-entrypoint export pattern.** The fs bridge is exported via a package sub-entrypoint (`@theplenkov/acpify/capabilities/vscodeFsBridge`) instead of the package's main `index.ts`. This is because the bridge imports the `vscode` runtime module, which only exists in the VS Code host. Importing the bridge from the package root would break Node consumers. **Subagents 05/06 should use the same sub-entrypoint pattern for their bridges.**
3. **Per-PR review rounds count.** Subagent 03 needed 4 PATCHER + 2 REVIEWER rounds to land. The bigger the change, the more rounds. Budget for 3–5 rounds in the loop.
4. **/act round 1 found 15 open threads on PR #4.** Substantive reply + resolve per thread, ~30 minutes work. **Don't skip the /act round even if "most of it was already addressed in PATCHER rounds."**

---

## 4. Lessons learned (consolidated from subagents 00–03)

See **`docs/lessons-learned.md`** for the full write-up. The 7 cross-cutting
rules and 6 procedural rules are unchanged from the subagent-02 handoff.
**Three rules in particular apply to subagent 04 (terminal bridge):**

- **Rule 4 (public surface exact match).** The contract declares `acp.CreateTerminalRequest` etc. The SDK uses long names like `acp.WaitForTerminalExitRequest`. Pick one and document.
- **Rule 5 (callbacks after operation).** `waitForExit` resolves the bridge's `Promise<...>` AFTER the SDK's `onDidCloseTerminal` event fires. Firing it on registration = the archive bug.
- **Rule 7 (catch RPC errors).** `release(terminalId)` for an unknown id → throw `RequestError`, not return `null` or `undefined`.

Plus a NEW rule from subagent 03:

- **Rule 14 (file-size budget).** Keep new files under ~200 LOC. If a file is approaching that, split into a sub-entrypoint and a helpers file. CodeScene flags 250+ LOC files as complexity violations.

---

## 5. The subagent loop — operational contract (unchanged)

For each new subagent task:

1. **Create a branch off `main`.** `git fetch origin main && git checkout -b task/NN-task-name origin/main`. Use the same naming convention (`task/04-terminal-bridge`, etc.).
2. **Dispatch the PATCHER.** Single subagent with a focused `SUBAGENT_CONTEXT_CAPSULE` containing: exact files in scope, exact files forbidden, TDD order, success criteria, reference docs to read first.
3. **Verify locally.** `cd packages/acpify && npx tsc --noEmit -p tsconfig.json && npx vitest run` then `npm run build -ws` then `cd apps/extension && npx @vscode/vsce package --no-dependencies`. Must all be green before REVIEWER.
4. **Dispatch the REVIEWER.** Single subagent with: severity-labelled findings format, contract-compliance checks, codehome lens, minimal-root-cause lens.
5. **Iterate PATCHER on REVIEWER's CRITICAL/IMPORTANT.** Reuse the same task contract. The loop ends when REVIEWER returns CLEAN or MINOR-only.
6. **Commit + push + open PR.** PR title `feat(acpify): <task-name>`.
7. **`/act` on the opened PR.** Substantively reply to every AI reviewer thread + resolve. Loop on any IMPORTANT/CRITICAL findings.
8. **Squash-merge to main.** `--delete-branch=false` (keep the branch until subagent N+1 branches from it).

The PATCHER does NOT commit — that is your job after REVIEWER returns CLEAN.

---

## 6. Plan: subagent 04 — `terminal` bridge

**Contract:** `docs/agent-tasks/04-terminal-bridge.md`.

**Goal:** Add `vscodeTerminalBridge.ts` + test under `packages/acpify/src/capabilities/`. Implement 4 reverse-call handlers:
- `create(req)`: spawn `vscode.window.createTerminal({name, env, cwd})`; stash id→terminal in a `Map`; return `{ terminalId }`
- `output(req)`: look up terminal, call `terminal.sendText(...)`; return new output buffer
- `waitForExit(req, signal?)`: subscribe to `onDidCloseTerminal`; resolve with `{ exitCode }`; honour `AbortSignal`
- `release(req)`: dispose terminal; remove from map

**Consumes:** Same `CliAcpClient` handler interface from subagent 01. The SDK's handlers object — add `onCreateTerminal`, `onTerminalOutput`, `onWaitForExit`, `onReleaseTerminal` to the call site of `client.connect(...)`.

**Important context the next agent MUST know** (recurring pitfalls from 00–03):
- **TDD**: write the failing test FIRST, assert it fails with `module not found`, THEN write the implementation.
- **Files**:
  ```
  packages/acpify/src/capabilities/vscodeTerminalBridge.ts
  packages/acpify/src/capabilities/vscodeTerminalBridge.test.ts
  ```
  Also edit `packages/acpify/src/index.ts` (re-export the bridge factory from a sub-entrypoint) and `packages/acpify/src/client/cliClient.ts` (thread the new handlers into the `ClientSideConnection` constructor).
- **Test infrastructure**: mock `vscode` via `vi.mock("vscode", ...)`. See `packages/acpify/src/capabilities/vscodeFsBridge.test.ts` for the pattern (mock `vscode.window.createTerminal`, `terminal.sendText`, `onDidCloseTerminal`, etc.).
- **File budget**: ≤4 files (per the task doc). Aim for subagent 03's pattern: one main file + one test file + 1-2 minimal index.ts/cliClient.ts edits.
- **Settlement rule concern**: `waitForExit` resolves the promise AFTER `onDidCloseTerminal` fires. Subscribing in the wrong order (synchronously) = archive bug. Use `await new Promise<number>((resolve, reject) => { const sub = onDidCloseTerminal(t => { if (t === terminal) { sub.dispose(); resolve(t.exitStatus?.code ?? 0); } }); signal?.addEventListener('abort', () => { sub.dispose(); reject(new Error('aborted')); }); })`.
- **File size rule** (Rule 14): keep the implementation file under ~200 LOC. If the logic grows, split into `vscodeTerminalBridge.ts` (factory + lifecycle) + `vscodeTerminalBridge.lifecycle.ts` (wait/exit) + `vscodeTerminalBridge.registry.ts` (the terminal-id map).

**Allowed scope** (per the contract):
- Create: `packages/acpify/src/capabilities/vscodeTerminalBridge.ts`, `vscodeTerminalBridge.test.ts`
- Edit: `packages/acpify/src/index.ts` (re-export), `packages/acpify/src/client/cliClient.ts` (handler thread only)

**Forbidden scope:**
- Anything else.

---

## 7. Plan: subagents 05–11

| # | Task | Depends on |
|---|------|------------|
| 05 | Permission bridge + persistent rule store + globalState wiring | PR 03 (session, `AcpSession.handleSessionUpdate`) |
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

- **Branch you branch from:** `main` at `1a27b4f`
- **`task/02-session-pool` and `task/03-fs-bridge` still exist on remote** (we used `--delete-branch=false` in the squash merges). Doesn't matter — main is your base.
- **`base/barebone` is gone** (squash-deleted in PR #1).
- **`task/01-sdk-client` is gone** (squash-deleted in PR #2).

### Fix the contract docs before dispatching

**Important bug in the contract docs**: success criteria line 65 of `04-terminal-bridge.md` says `git diff --stat base/barebone..HEAD` — this is wrong. The current base is `main`, not `base/barebone` (which no longer exists). The next agent should fix this in their PATCHER context capsule to `git diff --stat main..HEAD`.

### Commands

```bash
cd /workspace/23c24809-5738-4967-a170-47e98e817b9d/sessions/agent_bb130001-e128-43fc-bf37-4a4514f4703a

git fetch origin main
git checkout -b task/04-terminal-bridge origin/main
# ... work ...
git add -A && git commit -m "feat(acpify): terminal bridge (subagent PR 04)"
git push -u origin task/04-terminal-bridge
gh pr create --base main --head task/04-terminal-bridge --title "feat(acpify): terminal reverse-call bridge" --body "..."
```

### CI rebuild needed after every dependency change

Always `rm -rf apps/extension/dist packages/*/dist` and rebuild before verifying — `tsdown` doesn't track transitive dependency changes in `node_modules`.

### Bundle invariants per PR

After each PR's build, check:

```bash
unzip -p apps/extension/vscode-model-provider-0.2.0.vsix extension/dist/extension.mjs | grep "^import"
# Expect: vscode + a few node: built-ins (child_process, stream). NO @theplenkov/* imports (everything is bundled).
```

---

## 9. End-state summary (for human eyes)

After four merged PRs (one barebone + three subagents), the architecture is real:

- **`@theplenkov/acpify`**: `CliAcpClient` (SDK-backed stdio JSON-RPC) + `SessionPool`/`AcpSession` (persistent per-cwd sessions with FIFO queue, settlement-once contract, idle eviction, lifecycle correctness) + `vscodeFsBridge` (fs/read_text_file + fs/write_text_file with path-traversal protection).
- **`@theplenkov/claude-config`**: skeleton; PR 10.
- **`@theplenkov/claude-acp`**: skeleton; PR 07 + PR 10.
- **`apps/extension`**: thin shell, registers LMCP for vendor `acp`, constructs `SessionPool`, no-op reverse-call handlers waiting for PRs 04–06.

What's working: the package boots, registers a chat vendor (currently empty — no models exposed), constructs the session pool, integration test infrastructure for the SDK client + session pool + fs bridge.

What's not yet: models exposed, terminal/permission/elicitation bridges, discovery, permissions UI, host test, marketplace-quality docs.

Seven subagents remain, in dependency order: 04 (terminal) → 05 (permission) → 06 (elicitation) → 07 (discovery, can run in parallel with 04–06) → 08 (fake stdio fixture) → 09 (registry, replaces barebone) → 10 (api-helper) → 11 (CI nightly, README).

The agent who picks up next: read §1, §3, §5, §6 of this handoff. The rest of the doc is reference material to have on hand.

---

## 10. File history (for the handoff chain)

- `docs/handoff/2026-06-30-subagent-00-foundation.md` — initial state capture (before barebone merge)
- `docs/handoff/2026-07-01-subagent-02-complete.md` — handoff for subagent 03 (fs bridge). Successfully picked up.
- `docs/handoff/2026-07-02-subagent-03-complete.md` — this file. Handoff for subagent 04 (terminal bridge).
