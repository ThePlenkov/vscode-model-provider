# Task 11 — CI, docs polish, Tier-3 host test plan

**Role:** patcher subagent.

**Allowed scope**

- edit: `.github/workflows/ci.yml` (Vitest unit on every push; `@vscode/test-electron` nightly on a self-hosted runner with `claude --acp` installed)
- edit: `README.md` (replace the "Temporary testing solution" wording, the absolute-path default, the manual install instructions; document the new architecture at a high level)
- edit: `docs/architecture.md` (only to add a §Verified at the bottom that links to the most recent green CI run)
- create: `apps/extension/test/host/runHostTests.ts` (skeleton — full Tier-3 tests land in a future PR, but the file must compile and the runner must succeed in `--listTests` mode)

**Forbidden scope**

- `apps/extension/src/`
- `tests/fixtures/`
- `nx.json`, root `package.json` (unless a workflow change requires a script)

**TDD order (mandatory)**

1. **RED.** Locally: `act -j unit-test` (or `npm test` in a clean clone) must fail with the new workflow before this PR's changes. Actually skip this — workflow files are not unit-tested. Just verify `actionlint` passes:
   ```
   npx actionlint .github/workflows/ci.yml
   ```
2. **GREEN.** Apply the changes; `actionlint` passes; `gh workflow view` shows the expected jobs.
3. **REFACTOR.** N/A.

**CI shape (required)**

```yaml
on:
  push:           { branches: [main] }
  pull_request:   { branches: [main] }
  workflow_dispatch: {}
  schedule:       [{ cron: "0 3 * * *" }]   # nightly Tier-3

jobs:
  unit-test:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node@v6, npm ci, npm run compile, npx vitest run]

  fake-agent-e2e:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node@v6, npm ci, npm run compile, npx vitest run --project fake]

  build:
    needs: [unit-test, fake-agent-e2e]
    runs-on: ubuntu-latest
    steps: […, npx @vscode/vsce package --no-dependencies, upload-artifact]

  host-electron:
    if: github.event_name == 'schedule'
    runs-on: [self-hosted, acp]            # requires a self-hosted runner label `acp` with `claude --acp` on PATH
    steps: [checkout, setup-node@v6, npm ci, npm run compile, xvfb-run --auto-servernum npm run test:host]

  release:
    needs: build
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps: […download-artifact, softprops/action-gh-release@v2…]
```

**README shape (required)**

- Drop the "Temporary testing solution" line.
- Drop the absolute-path default from the sample config.
- Add a 4-line "How it works" paragraph summarising ACP + persistent sessions.
- Add a "Tested with" table: Claude Code 1.x, Gemini CLI 0.x, GitHub Copilot CLI 0.x (versions that we have actually run Tier-2/3 against).
- Add a "What is *not* yet implemented" bullet list of the still-open PRs (08, 10, 11's host tests, and any items still in `docs/agent-tasks/` that have not landed).

**Success criteria**

- `npx actionlint .github/workflows/ci.yml` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 5 files changed
- The README does not contain the string `Temporary` or `/mnt/wsl/`

**Output contract** — same shape as task 01, with the `actionlint` output added.
