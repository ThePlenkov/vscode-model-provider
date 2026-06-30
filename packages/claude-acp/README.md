# `@theplenkov/claude-acp`

Claude Code adapter for `@theplenkov/acpify`. One package per agent.

## What this package owns

- **`adapter`** — a single `BuiltinAdapter` entry:
  ```ts
  export const adapter = {
    id: "claude-code",
    label: "Claude Code",
    cliCommand: "claude",
    cliArgs: ["--acp"],
    homepage: "https://docs.anthropic.com/en/docs/claude-code",
  };
  ```
- **`resolveEnv`** — reads the Claude Code config from
  `@theplenkov/claude-config` and produces the env vars to inject into the
  spawn.
- **`mapModelId`** — turns Claude's raw model ids (`claude-3-5-sonnet-20241022`)
  into user-facing aliases (`sonnet`, `opus`).

## Why one package per agent

Adding Gemini / Codex / OpenCode / Cursor / Kilo support means adding another
package (`@theplenkov/adapter-gemini`, `@theplenkov/adapter-codex`, …). Each
is independently installable, versionable, and testable. The core does not
need to know which adapters exist; the host extension composes them.

## Status (barebone)

Empty `src/index.ts`. The full surface lands with subagent PRs 07 and 10
(see `docs/agent-tasks/`).