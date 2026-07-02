# Lessons learned — synthesized from subagent PRs 00–02

> The cross-cutting rules below were extracted from three merged PRs
> (barebone + SDK client + session pool), each with multiple
> PATCHER + REVIEWER cycles. Every rule here is something that cost a
> round of review to discover. **Read this before dispatching any
> subagent task.**
>
> Use this as the pre-flight checklist when you write a
> `SUBAGENT_CONTEXT_CAPSULE`.

---

## Rule 1. Never use wall-clock sleeps in tests

**Why it matters:** slow CI runners + noisy CI make wall-clock sleeps flakier over time. Worse, a test that just waits before asserting will trivially pass on any implementation including a buggy one.

**Patterns that work:**

- Deterministic stream-splitting at an adapter boundary. Wrap a `Readable.toWeb(...)` stream in a Transform that emits the first half synchronously and defers the second half to a `Promise.resolve()` microtask.
- Drive settlement through a Promise the test controls (`fake.settle('end_of_turn')` is more reliable than `await new Promise(r => setTimeout(r, 50))`).
- For queue ordering, dispatch the next `prompt()` after the fake has *signalled* the in-flight prompt has been seen (via the `await flush()` pattern, not via sleep).
- For idle-eviction, use `vi.useFakeTimers()` + `vi.advanceTimersByTime(...)`.

**Concrete hits** (so you can search the repo for them):
- PATCHER round 1 of subagent 01 — Test 1 (NDJSON framing) used `setTimeout(..., 30)`. Caught in round 2.
- PATCHER round 2 of subagent 02 — same `setTimeout` pattern showed up in mid-stream checks. Replaced with microtask flush.

---

## Rule 2. Never reimplement a Node built-in (or any upstream library)

**Why it matters:** Every layer of "I'll just write my own X" reintroduces bugs the upstream library already debugged. The /act cycles will catch these because they specifically look for "Do not rewrite" violations.

**Specific traps:**

- `Readable.toWeb(nodeReadStream)` / `Writable.toWeb(nodeWriteStream)` are Node 18+ built-ins. Do NOT wrap them.
- JSON-RPC framing, request/response correlation, notification dispatch — the SDK handles all of it. Do NOT reimplement on top of `child_process`.
- `child_process.spawn` is sufficient. Do NOT wrap it.

**Concrete hits:**
- PATCHER round 1 of subagent 01 — `streamBridge.ts` wrapped `Readable.toWeb`/`Writable.toWeb`. Caught by REVIEWER round 1. ~65 LOC deleted in round 2.

---

## Rule 3. A test that does not exercise the implementation trivially passes

**Why it matters:** When a test never reaches the code path it claims to test, it passes on both the correct implementation and the buggy one. The test gives false safety. This is harder to detect than it sounds — the test LOOKS like it covers the feature.

**Falsification trace** is the audit technique: for every new test, write out what the buggy implementation would do, and trace whether the test would catch it.

**Concrete hits:**
- PATCHER round 2 of subagent 02 — `end_of_turn` test drove 6 chunks via `pushChunk` which just appended to an array. The buggy archive code (resolved on first chunk) would also pass. Fixed in round 3 by wiring `onSessionUpdate` through a real handler.

**Pattern:** if the test mutates a fake and then asserts, the fakes must **invoke** the implementation-under-test, not merely side-effect. The `fake.settle(...)` helper in `session.test.ts` is good (it resolves the in-flight promise); `fake.pushChunk(...)` was bad (it only mutated an array).

---

## Rule 4. Public surface must match the contract doc exactly

**Why it matters:** consumers compile against the doc, not the .d.ts. If the .d.ts drifts from the doc (or vice versa), downstream code compiles fine and breaks at runtime. This is the most expensive bug class because it shows up in PRs that consume the changed surface.

**Concrete hits:**
- PATCHER round 1 of subagent 02 — added a 3rd param to `SessionPool` constructor that the doc didn't declare. Any consumer calling `new SessionPool(factory, { idleEvictMs: ... })` would have silently passed `{idleEvictMs: ...}` as `connectFn` at runtime. REVIEWER round 1 caught it.
- Round 2 of subagent 02 — `onSessionCreated` callback fires in `createSession` BEFORE `ensureStarted`, so the callback dereferences a throwing getter. Caught by AI panel review (Kilo, Gemini, amazon-q, codeant).
- Round 2 of subagent 02 — `SessionConnectFn` was parameterless even though the handshake needs to call `client.connect()` and `client.sessionNew()`. Restructured to `(client, key) => Promise<{sessionId}>`.

**Pattern:** before dispatching a PATCHER, the SUBAGENT_CONTEXT_CAPSULE must explicitly list the public surface declared in the contract doc and state "match this exactly."

---

## Rule 5. Lifecycle callbacks must fire AFTER the operation they observe

**Why it matters:** a callback fired before the inner operation completes masks failures. If the operation errors AFTER the callback, the caller assumes success.

**Concrete hit:** PATCHER round 2 of subagent 02 — `sweepIdle` fired `onSessionEvicted('idle')` THEN called `await session.disconnect()`. If the disconnect threw, the callback had already fired.

**Pattern:**

```
try {
  await inner.operation();
  callback('success', key);
} catch (err) {
  callback('error', key, err);
}
```

Never fire the success callback before the await resolves.

---

## Rule 6. Update timestamp on every relevant event, not just start and end

**Why it matters:** idle-eviction heuristics use lastUsed to find sessions whose work has stopped. If you update lastUsed only at start and end, long-running operations appear idle.

**Concrete hit:** PATCHER round 1 of subagent 02 — `lastUsed` only updated at prompt start and end. A 31-min prompt with `idleEvictMs=30min` would be evicted mid-flight because the session "appeared idle."

**Pattern:** the public `handleSessionUpdate` hook (added in subagent 02 round 3) calls `touch()` on every inbound notification. For any class with an idle heuristic, trace every code path where work happens and ask "does this keep lastUsed fresh?"

---

## Rule 7. Async RPC errors must be caught

**Why it matters:** `void somePromise` only silences the return value. A rejection becomes an unhandled rejection and pollutes the process's error stream.

**Concrete hit:** PATCHER round 1 of subagent 02 — `void this.client.sessionCancel(...)`. If the agent died mid-cancel, an unhandled rejection fires.

**Pattern:**

```ts
void this.client.sessionCancel({ sessionId }).catch(() => {
  // The agent is gone; the dispatch loop will surface this.
});
```

Always chain a `.catch` (or `await` it). If you genuinely want the error to propagate, `await` it explicitly.

---

## Procedural rules (subagent loop + /act discipline)

### Rule 8. PATCHER → VERIFIER → REVIEWER, sequential, one subagent per round

- Sequential, not parallel. Parallel PATCHERs hit rate limits + debug handoff.
- PATCHER does NOT commit. Reviewer verifies. General (you) commits and pushes.
- VERIFIER is the local subagent that re-runs the test suite. Sometimes folded into PATCHER round 2 if the diff is small.

### Rule 9. /act discipline: substantive reply per thread BEFORE resolve

- Resolve-only is wrong. Each AI reviewer (CodeRabbit, Kilo, Amazon Q, cubic, Gemini, CodeAnt, SonarCloud, CodeScene, Codacy) leaves real findings.
- Reply to every thread with: what was wrong (cite the line number), what was fixed (cite the new line number), what commit. Then resolve.
- If the finding is wrong (it happens — reviewers can misread), push back: explain why the finding doesn't apply, with code references.

### Rule 10. CI gate order: build before typecheck

- `tsc --noEmit` in consumer packages needs `dist/` from producer packages (resolved via the package's `exports` field).
- The `.github/workflows/ci.yml` typecheck job re-runs build first. Don't break this.

### Rule 11. tsconfig include must stay synced with deletions

- Reviewers (Kilo caught this) flag dead `include` references. `tsc` itself doesn't fail on them.
- Always `grep include` in your tsconfigs after deleting source files.

### Rule 12. External check services often require auth we don't have

- Codacy, CodeScene flag FAILURE/ACTION_REQUIRED with opaque details.
- Document the verdict in the PR body. Proceed with the merge if GitHub considers it MERGEABLE. File a follow-up PR when the user grants the auth token (or just split files if size is the heuristic trigger).
- **Workaround for CodeScene file-size flags**: when CodeScene flips to FAILURE on a large diff, the next agent's response (subagent 03 round 4) was to **split the implementation file** AND **extract helpers** into separate files. This dropped CodeScene complexity flags. Rule 14 below.

---

### Rule 14 (NEW, from subagent 03). Keep new files under ~200 LOC

**Why it matters:** CodeScene's code-health heuristic flags files over ~250 LOC as complexity violations. Subagent 03's fs bridge PR got flagged because the implementation file was 257 LOC; the next agent split the file and extracted helpers to address it. The git history explicitly shows `refactor(acpify): extract helpers to drop CodeScene complexity flags`.

**Patterns:**

- One main file (~150–200 LOC) for the public surface + glue.
- Optional helpers file (~100 LOC) for the I/O, validation, and error-mapping logic.
- Test file is exempt from this rule (test files can be longer; they read as a list of cases).
- When a file approaches 200 LOC, **proactively split** before submitting. Don't wait for CodeScene to flag it.

**Concrete hit:**
- PR #4 had `vscodeFsBridge.ts` at 257 LOC. The next agent did commit `e8f814a feat(acpify): split fs bridge into sub-entrypoint + harden path resolution` and `d193b703 refactor(acpify): extract helpers to drop CodeScene complexity flags`.

---

### Rule 16 (NEW, from subagent 04). Sanity-check contract-doc type names against the installed SDK before scaffolding tests

**Why it matters:** The contract doc for subagent 04 listed `acp.WaitForExitRequest` and `acp.WaitForExitResponse` as the public surface, but the installed `@agentclientprotocol/sdk` exports these as `acp.WaitForTerminalExitRequest` and `acp.WaitForTerminalExitResponse`. The RED-phase test scaffold was uncompilable until the type names were tightened. This blocked GREEN for an entire round and forced a test rewrite under the patcher's deadline.

**Pattern:** before dispatching a PATCHER, run a single grep against the installed SDK and confirm the type names in the contract doc actually exist:

```bash
grep -E "type WaitFor|type Create|type Terminal" \
  node_modules/@agentclientprotocol/sdk/dist/schema/index.d.ts
```

If the contract doc's type names don't appear, the contract is wrong — either rewrite the contract doc (if scope allows) or pre-emptively use the SDK names in the scaffold and document the deviation in the handoff.

**Concrete hit:** subagent 04's `docs/agent-tasks/04-terminal-bridge.md` "Public surface (required)" block used `acp.WaitForExitRequest` / `acp.WaitForExitResponse`. The SDK has no such types. The RED scaffold was uncompilable; the PATCHER had to rewrite the test to use `acp.WaitForTerminalExitRequest` / `acp.WaitForTerminalExitResponse` before GREEN could even start.

### Rule 17 (NEW, from subagent 04). When a contract clause is internally inconsistent with the SDK, pick the SDK interpretation and document

**Why it matters:** Rule 4 says "public surface must match the contract doc exactly." Rule 17 refines: when the contract doc contradicts the installed SDK (which it sometimes does — contract docs are written ahead of, or out of sync with, SDK releases), the SDK wins. Document the deviation in the handoff and (if scope allows) the contract doc itself. This keeps the bridge code compileable AND the contract auditable.

**Pattern:**

1. Identify the contract clause that contradicts the SDK.
2. Pick the SDK interpretation. The bridge compiles against the SDK, not the contract doc.
3. Document in the handoff: "Contract doc says X; SDK actually does Y; this PR implements Y and records the deviation here."
4. If `docs/` is in allowed scope, edit the contract doc in the same PR. Otherwise, the next agent picking up the contract doc sees the deviation in the handoff history.

**Concrete hit:** subagent 04's contract doc claimed `terminal/output` "writes the bytes via `terminal.sendText`" but the SDK's `TerminalOutputRequest` has no `data` field. The bridge reads `(req as unknown as { data?: string }).data` and writes through `sendText`; the deviation is recorded in `docs/handoff/2026-07-02-subagent-04-complete.md` §3.

---

### Rule 15 (NEW, from subagent 03). Use a sub-entrypoint for VS Code-coupled packages

**Why it matters:** `vscodeFsBridge` imports the `vscode` runtime module, which is only available in the VS Code host. If a Node consumer (e.g. a CLI tool, a test runner) accidentally imports the package's main `index.ts`, they get `ERR_MODULE_NOT_FOUND` because `vscode` is a devDependency only.

**Pattern:** export the bridge from a sub-entrypoint, not the package root.

```ts
// packages/acpify/package.json
"exports": {
  ".": { "import": "./dist/index.js" },                       // package root
  "./capabilities/vscodeFsBridge": {                         // sub-entrypoint
    "import": "./dist/capabilities/vscodeFsBridge.js"
  }
}
```

The package root re-exports only the agent-agnostic core (client, session). The bridge is reachable via the explicit sub-entrypoint.

**Concrete hit:** subagent 03's commit `e8f814a feat(acpify): split fs bridge into sub-entrypoint + harden path resolution` introduced this pattern. Subagent 04 (terminal bridge) and 05/06 (permission/elicitation bridges) should follow the same pattern.

---

## Synthesis: the subagent-instruction template

When writing a `SUBAGENT_CONTEXT_CAPSULE`, include the relevant rule IDs:

- Rule 1 (no wall-clock sleeps): "tests must be deterministic — see `docs/lessons-learned.md` Rule 1. If the test needs to wait for an async operation, drive it through a Promise the fake controls, not `setTimeout`."
- Rule 4 (public surface match): "the public surface declared in this contract must match exactly — see `docs/lessons-learned.md` Rule 4."
- Rule 5 (callbacks after operation): "if you add a callback, fire it AFTER the inner operation resolves — see `docs/lessons-learned.md` Rule 5."
- Rule 6 (lastUsed on every event): "every async event handler must `touch()` the session — see `docs/lessons-learned.md` Rule 6."
- Rule 7 (catch RPC errors): "`void somePromise` is not enough — chain `.catch` — see `docs/lessons-learned.md` Rule 7."
- Rule 14 (file-size): "keep new files under ~200 LOC; split before CodeScene complains. See `docs/lessons-learned.md` Rule 14."
- Rule 15 (sub-entrypoint): "VS Code-coupled bridges go under a sub-entrypoint, not the package root. See `docs/lessons-learned.md` Rule 15."

Most subagent bugs in this codebase have been violations of these 9 rules. The list is exhaustive.
