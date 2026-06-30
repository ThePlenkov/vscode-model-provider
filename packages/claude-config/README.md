# `@theplenkov/claude-config`

Claude Code configuration resolver. Agent-specific — Claude Code only.

## What this package owns

- **Environment variables** Claude Code honours:
  - `ANTHROPIC_API_KEY` — direct API key
  - `ANTHROPIC_AUTH_TOKEN` — bearer token (preferred for proxies)
  - `ANTHROPIC_BASE_URL` — proxy / API-helper endpoint
  - `CLAUDE_CONFIG_DIR` — overrides `~/.claude`
- **Settings resolution order** (highest precedence first):
  1. Managed settings — macOS MDM (`/Library/Application Support/ClaudeCode/managed-settings.json`)
     / Windows HKLM / Linux `/etc/claude-code/managed-settings.json`
  2. CLI flags: `--settings <path-or-json-string>` overrides the same keys for the session
  3. `.claude/settings.local.json` (project-local, not committed)
  4. `.claude/settings.json` (project, committed)
  5. `~/.claude/settings.json` (user-global)
- **Session log directory** — `~/.claude/projects/<sha(cwd)>/`.
- **`CLAUDE.md` discovery** — per-cwd and per-parent-directory lookups, plus imported `CLAUDE.md` from `~/.claude/CLAUDE.md`.
- **Plugin/skill/agent/MCP paths** — `.claude/{plugins,skills,agents}/`,
  `~/.claude/{plugins,skills,agents}/`, `.mcp.json` resolution.

Note: Claude Code does **not** honour `NO_COLOR`. ANSI can be stripped by
launching the CLI through a wrapper or by setting `--output-format` to
`json` for machine-readable output.

## Status (barebone)

Empty `src/index.ts`. The full surface is added by subagent PRs 07 and 10
(see `docs/agent-tasks/`).

## Why it's a separate package

Three reasons:

1. **Reuse.** Other Claude Code integrations (the `claude-agent-acp` adapter,
   third-party extensions) want the same config resolution without dragging in
   our ACP client and session pool.
2. **Replaceability.** If Anthropic changes the env var names or the config
   layout, only this package needs to change. `acpify` and
   `claude-acp` consume a stable interface.
3. **Single source of truth.** Today, every Claude Code tool re-derives the
   env vars from first principles. This package is the one place that gets
   it right.