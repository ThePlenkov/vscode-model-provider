# Specs

The four specs / references every contributor must have open while
implementing their subagent task.

## Wire protocol

- **ACP v1** — <https://agentclientprotocol.com/protocol/overview>
- **ACP schema (TypeScript)** — `@agentclientprotocol/sdk` 1.1.x, distributed
  in this repo via `apps/extension/package.json`. Read
  `node_modules/@agentclientprotocol/sdk/dist/*.d.ts` for the authoritative
  types.
- **claude-agent-acp (reference impl)** —
  <https://github.com/agentclientprotocol/claude-agent-acp>. Their
  `src/acp-agent.ts` is the pattern the session pool follows (see PR 02).

## VS Code extension surface

- **`vscode.lm.registerLanguageModelChatProvider`** —
  <https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider>
- **LMCP vended model contract** — same page, "Define a chat model".
  The barebone `AcpProvider` (this PR) conforms to the contract; PR 09
  wires the real model list.

## Claude Code CLI

- **Official docs** — <https://docs.anthropic.com/en/docs/claude-code>
- **`--acp` flag** — runs Claude Code as an ACP agent over stdio.
  This is the *only* CLI flag the extension relies on.
- **Environment variables** the CLI honours:
  - `ANTHROPIC_API_KEY` — direct API key
  - `ANTHROPIC_AUTH_TOKEN` — bearer token (preferred for proxies)
  - `ANTHROPIC_BASE_URL` — proxy / API helper endpoint
  - `CLAUDE_CONFIG_DIR` — overrides `~/.claude` (used for multi-account isolation)
  - `NO_COLOR` — set by the extension to keep stderr parsing simple
- **Where the session lives** — `~/.claude/projects/<sha(cwd)>/` —
  per-cwd conversation log, slash-command history, permission rules.

## Other ACP agents (not all behaviours match; per-agent overrides live in `discovery/builtinAdapters.ts`)

| Agent        | CLI arg          | Notes                                  |
|--------------|------------------|----------------------------------------|
| Claude Code  | `claude --acp`   | reference; this PR is built around it  |
| Gemini CLI   | `gemini --experimental-acp` | flag name differs                  |
| GitHub Copilot CLI | `copilot --acp --stdio` | needs stdio explicit          |
| OpenCode     | `opencode acp`   | subcommand, not flag                   |
| Codex ACP    | `codex --acp`    | shipped by Zed                         |
| Qwen Code    | `qwen-code --acp`| flag                                   |
| Kiro CLI     | `kiro-cli acp`   | subcommand                             |

`discovery/pathScout.ts` is the single place that knows about all of
these; the rest of the codebase talks to a uniform `AcpSession`.

## VS Code capability advertisement (in `initialize`)

The extension advertises, in `clientCapabilities`:

```ts
{
  fs:       { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth:     { _meta: { "api-helper": true } },
  _meta:    { "terminal-auth": true },
}
```

Each capability *must* have a matching reverse-call handler in the
extension. PRs 03–06 land them one at a time.
