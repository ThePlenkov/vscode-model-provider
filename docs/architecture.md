# Architecture

The goal of `vscode-model-provider` is to expose any
[ACP](https://agentclientprotocol.com)-compatible coding agent (Claude
Code, Gemini CLI, Codex, OpenCode, Cursor, Kilo, …) as a native chat
model in VS Code's Copilot Chat, while inheriting every plugin, hook,
skill, subagent, and MCP server the CLI already exposes.

The architecture is split into **independent packages**, one per concern.
Each is independently buildable, testable, and (eventually) publishable.

## Package map

```
vscode-model-provider/                        ← THIS REPO (monorepo)
├── apps/
│   └── extension/                            ← thin VS Code shell (~100 LOC at first)
│       ├── src/extension.ts                  ← activate + register LMCP for vendor 'acp'
│       └── src/**.test.ts                    ← shell-level tests (added later)
│
├── packages/
│   ├── acpify/                             ← agent-agnostic ACP core
│   │   └── src/
│   │       ├── client/                       ← stdio JSON-RPC (PR 01)
│   │       │   ├── cliClient.ts              ← over @agentclientprotocol/sdk
│   │       │   └── streamBridge.ts           ← node <-> web stream conversion
│   │       ├── session/                      ← persistent pool, FIFO queue (PR 02)
│   │       │   ├── sessionPool.ts
│   │       │   ├── acpSession.ts
│   │       │   └── permissions.ts
│   │       ├── capabilities/                 ← reverse-call bridges (PRs 03–06)
│   │       │   ├── vscodeFsBridge.ts         ← imports vscode (allowed)
│   │       │   ├── vscodeTerminalBridge.ts   ← imports vscode (allowed)
│   │       │   ├── vscodePermissionBridge.ts ← imports vscode (allowed)
│   │       │   └── vscodeElicitationBridge.ts← imports vscode (allowed)
│   │       ├── discovery/                    ← PATH scout + adapter table (PRs 07, 10)
│   │       │   ├── pathScout.ts              ← does NOT import vscode
│   │       │   ├── builtinAdapters.ts        ← does NOT import vscode
│   │       │   └── cliWrapper.ts             ← does NOT import vscode
│   │       └── provider/                     ← LanguageModelChatProvider impl
│   │           ├── barebone.ts               ← ships in barebone (this PR)
│   │           └── acpProvider.ts            ← full registry (PR 09)
│   │
│   ├── claude-config/                        ← Claude Code config resolver
│   │   └── src/index.ts                      ← env vars, settings.json, CLAUDE.md (PRs 07, 10)
│   │
│   └── claude-acp/                       ← Claude Code adapter (one per agent)
│       └── src/index.ts                      ← BuiltinAdapter + model mapping (PRs 07, 10)
│
└── docs/
    ├── architecture.md                       ← this file
    ├── specs.md                              ← links to ACP, LMCP, Claude Code
    └── agent-tasks/01..11.md                 ← per-subagent task contracts
```

## The invariant: where `vscode` may be imported

| Package | Allowed to `import "vscode"`? | Why |
|---|---|---|
| `apps/extension` | yes | it IS the VS Code shell |
| `packages/acpify/src/capabilities/` | yes (type-only) | bridges must implement `vscode.*` contracts |
| `packages/acpify/src/provider/` | yes (type-only) | implements `vscode.LanguageModelChatProvider` |
| `packages/acpify/src/client/` | **no** | agent-agnostic transport |
| `packages/acpify/src/session/` | **no** | agent-agnostic session state |
| `packages/acpify/src/discovery/` | **no** | agent-agnostic PATH / spawn helpers |
| `packages/claude-config/` | **no** | pure config resolver |
| `packages/claude-acp/` | **no** | pure adapter config |

Enforced by ESLint (`no-restricted-imports`) once `acpify` ships its
client and session modules (PR #01 onward).

## Why split, not lump

1. **Reuse.** Other editor extensions (Cursor, Kilo, even a future JetBrains
   integration) can depend on `@theplenkov/acpify` without dragging in
   our VS Code-specific code.
2. **Replaceability.** Anthropic changes `~/.claude/`, we update
   `@theplenkov/claude-config`. We change session settlement, we update
   `@theplenkov/acpify`. The blast radius of every change is small.
3. **Independent publishing.** Today every package is `private: true`. The
   day someone wants to reuse `claude-config` from a CLI tool or another
   extension, they can `npm install @theplenkov/claude-config` without
   pulling in VS Code or ACP.
4. **Thin extension.** `apps/extension` is the only file that knows about
   `vscode.lm.registerLanguageModelChatProvider`. The provider is `new
   AcpBareboneProvider()` — a 1-line wire-up.

## Data flow (after all PRs land)

```
User picks  "ACP / Claude Code / Sonnet"   in Copilot Chat
        │
        ▼
   apps/extension/src/extension.ts
        │ new AcpBareboneProvider()  ← from @theplenkov/acpify
        ▼
   AcpBareboneProvider (this PR)
        │  returns [] for now
        │  PR 09 swaps this for AcpModelProvider
        ▼
   AcpModelProvider (PR 09)
        │
        │  list via @theplenkov/acpify's SessionPool
        ▼
   SessionPool (PR 02)  → keyed by (adapter.id, cwd) → AcpSession
        │
        │  one long-lived process, FIFO queue
        ▼
   CliAcpClient (PR 01) — wraps @agentclientprotocol/sdk
        │
        │  stdio JSON-RPC
        ▼
   `claude --acp`  (or gemini --experimental-acp, codex --acp, …)
        │
        │  reverse calls
        ▼
   Capability bridges (PRs 03–06)
        │   fs/read_text_file → vscode.workspace.openTextDocument
        │   terminal/create   → vscode.window.createTerminal
        │   permission        → vscode.window.showInformationMessage
        │   elicitation       → vscode.window.showQuickPick
        ▼
   vscode APIs

For Claude specifically:
   cliWrapper (PR 10)
        │
        │  reads @theplenkov/claude-config for env vars
        │  wraps CLI in api-helper if configured
        ▼
   `claude --acp` with correct env
```

## Why ACP and not the SDK

We deliberately talk to the CLI's `--acp` flag, not
`@anthropic-ai/claude-agent-sdk`:

- Plugins, hooks, and skills live in the CLI, not the SDK.
- The CLI re-reads `~/.claude/`, `.claude/`, and `CLAUDE.md` on every
  `session/new`. The SDK does not.
- Subagents (`.claude/agents/*.md`) are spawned as child processes by the
  CLI. The SDK does not start them.
- MCP servers from `.mcp.json` are also spawned by the CLI.
- The CLI is the only thing that has a stable, well-tested tool-call loop
  with `PreToolUse` / `PostToolUse` / `Stop` hooks attached.

ACP is the protocol the CLI speaks natively; using it preserves the
entire stack. See `docs/specs.md` for the wire-format links.

## Do not rewrite fundamental libs

- `@agentclientprotocol/sdk` — wire format, framing, typed notifications,
  `ClientSideConnection`. We do not reimplement any of this.
- `@anthropic-ai/claude-agent-sdk` (referenced from `claude-agent-acp`
  upstream) — also left alone. We use the CLI, not the SDK, for the
  reasons above.
- `node:child_process.spawn` — stdio subprocess. We do not wrap it.

Every per-PR task doc (`docs/agent-tasks/NN-*.md`) carries a "Do not
rewrite" header. Reviewers reject PRs that reimplement.

## Testing tiers

| Tier | Runner        | Scope                                                | Speed   |
|------|---------------|------------------------------------------------------|---------|
| 1    | Vitest        | per-module unit tests                                | <1 s    |
| 2    | Vitest + fake stdio server | full client/session logic without VS Code | <5 s    |
| 3    | `@vscode/test-electron` | VS Code host with real CLI              | ~60 s   |
| 4    | Playwright    | rendered UI (later)                                  | ~60 s   |

CI runs Tier 1+2 on every PR (`.github/workflows/ci.yml`). Tier 3 runs
nightly on a self-hosted runner that has `claude --acp` installed; it
falls back to a clear "skipped — no CLI" message otherwise. Tier 4 is a
future addition.

## What the barebone ships

- `apps/extension/src/extension.ts` — registers an empty LMCP for vendor
  `"acp"`.
- `@theplenkov/acpify/src/provider/barebone.ts` — the minimum
  compileable provider that returns 0 models.
- `@theplenkov/acpify/src/provider/barebone.test.ts` — 4 passing tests.
- Three package skeletons (`acpify`, `claude-config`, `claude-acp`).
- Architecture docs + 11 per-PR task contracts.
- A working `.github/workflows/ci.yml` that runs lint + typecheck + vitest
  + build + package on every PR and main push.

## What the barebone does *not* do

- It does not spawn any CLI.
- It does not implement any of the capability bridges, the session pool,
  or the discovery layer.
- It does not run any Tier-2 or Tier-3 test.

The next PR (01, the SDK client switch) replaces the client with the
SDK-backed one and adds the first round of Tier-1+2 tests against a
fake stdio agent.