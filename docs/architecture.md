# Architecture

The goal of `vscode-model-provider` is to expose any
[ACP](https://agentclientprotocol.com)-compatible coding agent (Claude
Code, Gemini CLI, Codex, OpenCode, …) as a native chat model in VS Code's
Copilot Chat, while inheriting every plugin, hook, skill, subagent, and
MCP server the CLI already exposes.

The architecture is split into modules, one per subagent PR. Each module
is independently testable, has its own failing test first, and lands as
a separate PR off `base/barebone`.

## Module map

```
src/
├── extension.ts                  # entry — activate/deactivate (this PR)
├── provider.ts                   # barebone AcpProvider           (this PR)
├── client/
│   ├── cliClient.ts              # SDK-backed stdio client        (PR 01)
│   └── streamBridge.ts           # node <-> web stream conversion (PR 01)
├── session/
│   ├── sessionPool.ts            # (agent, cwd) -> AcpSession     (PR 02)
│   ├── acpSession.ts             # persistent session, FIFO queue (PR 02)
│   └── permissions.ts            # allow/deny table in globalState (PR 05)
├── capabilities/
│   ├── vscodeFsBridge.ts         # fs/read_text_file + write      (PR 03)
│   ├── vscodeTerminalBridge.ts   # terminal/{create,output,...}   (PR 04)
│   ├── vscodePermissionBridge.ts # session/request_permission     (PR 05)
│   └── vscodeElicitationBridge.ts# unstable/create_elicitation    (PR 06)
├── discovery/
│   ├── pathScout.ts              # `command -v` per OS            (PR 07)
│   ├── builtinAdapters.ts        # default adapter table          (PR 07)
│   └── cliWrapper.ts             # env injection + api-helper     (PR 10)
├── provider/                     # registry rewrite (replaces     (PR 09)
│   ├── acpProvider.ts            # the barebone src/provider.ts)
│   └── modelInfo.ts
tests/
├── fixtures/
│   └── fakeAcpAgent.ts           # real stdio ACP server for tests(PR 08)
└── unit/
    └── *.test.ts                 # per-module unit tests          (per PR)
docs/
├── architecture.md               # this file
├── specs.md                      # links to ACP, LMCP, Claude Code
└── agent-tasks/
    ├── 01-sdk-client.md
    ├── 02-session-pool.md
    ├── …
    └── 11-ci-docs.md
```

## Why one module per PR

Two reasons:

1. **Sequential subagents** — each subagent gets a directory it does
   not share with any other, so they cannot collide and the diff stays
   obviously correct. The PATCHER → VERIFIER → REVIEWER loop runs once
   per PR.
2. **Ponytail / minimal root cause** — every module answers one
   question. The "fs bridge" PR cannot regress the "session pool" PR
   because they do not share a file.

## Data flow (after all PRs land)

```
User picks
"ACP / Claude Code / Sonnet"        in Copilot Chat
        │
        ▼
   AcpProvider (PR 09)
        │
        │  session/load on first use
        ▼
   SessionPool (PR 02)  → keyed by (agent, cwd) → AcpSession
        │
        │  one long-lived process, FIFO queue
        ▼
   CliAcpClient (PR 01) — wraps @agentclientprotocol/sdk
        │
        │  stdio JSON-RPC
        ▼
   `claude --acp`  (or gemini, codex, …)
        │
        │  reverse calls
        ▼
   Capability bridges (PR 03–06) → vscode.workspace.*, terminal, info/quickpick
```

The CLI's own session machinery (skills, hooks, plugins, subagents, MCP,
CLAUDE.md, conversation memory) is loaded exactly once per `(agent,
cwd)` and re-used across every chat turn. That is the property the
current code throws away.

## Why ACP and not the SDK

We deliberately talk to the CLI's `--acp` flag, not `@anthropic-ai/claude-agent-sdk`:

- Plugins, hooks, and skills live in the CLI, not the SDK.
- The CLI re-reads `~/.claude/`, `.claude/`, and `CLAUDE.md` on every
  `session/new`. The SDK does not.
- Subagents (`.claude/agents/*.md`) are spawned as child processes by
  the CLI. The SDK does not start them.
- MCP servers from `.mcp.json` are also spawned by the CLI.
- The CLI is the only thing that has a stable, well-tested tool-call
  loop with `PreToolUse` / `PostToolUse` / `Stop` hooks attached.

ACP is the protocol the CLI speaks natively; using it preserves the
entire stack. See `docs/specs.md` for the wire-format links.

## Testing tiers

| Tier | Runner        | Scope                              | Speed |
|------|---------------|------------------------------------|-------|
| 1    | Vitest        | per-module unit tests              | <1 s  |
| 2    | Vitest + fake stdio server | full client/session logic without VS Code | <5 s |
| 3    | `@vscode/test-electron` | VS Code host with real CLI    | ~60 s |
| 4    | Playwright    | rendered UI (later)                | ~60 s |

CI runs Tier 1+2 on every PR. Tier 3 runs nightly on a self-hosted
runner that has `claude --acp` installed; it falls back to a clear
"skipped — no CLI" message otherwise. Tier 4 is a future addition.

## What this PR (barebone) does *not* do

- It does not spawn any CLI. No agent is registered, no process is started.
- It does not implement any of the capability bridges.
- It does not run any tier-2 or tier-3 test. The smoke test in
  `src/provider.test.ts` is Tier 1 only.

The next PR (01) replaces the barebone with the SDK-backed client and
adds the first round of Tier-1+2 tests against a fake stdio agent.
