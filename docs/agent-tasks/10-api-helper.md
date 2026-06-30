# Task 10 — API helper + environment injection

> **Do not rewrite.** The Claude-specific env var resolution lives in
> `@theplenkov/claude-config` — this PR calls into it, does not reimplement
> env var logic.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/claude-config/src/{env.ts,settings.ts,paths.ts,index.ts,env.test.ts}` (the actual env var resolution, settings.json lookups, CLAUDE.md discovery, session-log path)
- create: `packages/acpify/src/discovery/cliWrapper.ts`
- create: `packages/claude-acp/src/index.ts` (finalise the Claude adapter: `cliCommand`, `cliArgs`, `resolveEnv`, `mapModelId`; uses `@theplenkov/claude-config`)
- create: `packages/acpify/src/discovery/cliWrapper.test.ts`
- edit:   `apps/extension/src/extension.ts` (only to pass a `cliWrapper` into the `SessionPool`)
- edit:   `apps/extension/package.json` (add the new settings to `contributes.configuration`)

**Forbidden scope**

- `packages/acpify/src/capabilities/`
- `packages/acpify/src/provider/` (read-only — must not change PR 09's API)
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/specs.md` §Claude Code CLI environment variables
2. `docs/architecture.md` §Why ACP and not the SDK

**TDD order (mandatory)**

1. **RED.** Write `cliWrapper.test.ts` with the five tests below.
2. **GREEN.** Implement.
3. **REFACTOR.**

**Required tests**

- **No api-helper, no extra env.** With `apiHelper.enabled = false` and `baseUrl = undefined`, the wrapper returns `{ cmd, args, env: { NO_COLOR: "1" } }`.
- **Direct env injection.** With `baseUrl = "https://proxy.example.com"` and `token = "sk-…"`, the wrapper sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in the env.
- **api-helper wraps the CLI.** With `apiHelper.command = "/usr/local/bin/rotate.sh"`, the wrapper returns `{ cmd: "/usr/local/bin/rotate.sh", args: [originalCmd, ...originalArgs] }` and **does not** set `ANTHROPIC_*` env vars (the helper owns that).
- **Per-agent env override.** With `agentEnvOverride = { "github-copilot-cli": { GH_TOKEN: "ghp_…" } }`, the wrapper sets `GH_TOKEN` for the GitHub Copilot CLI only.
- **Refresh interval.** With `apiHelper.refreshMs = 60_000`, a long-lived `CliAcpClient` is given a `setInterval` that re-runs the helper to refresh env on every refresh. (Tier-1 test only asserts the interval was created.)

**Public surface**

```ts
export interface CliWrapperOptions {
  apiHelper?: { command: string; args?: string[]; refreshMs?: number };
  baseUrl?: string;
  authToken?: string;
  agentEnvOverride?: Record<string, Record<string, string>>;  // adapterId -> env
}

export interface ResolvedSpawn {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** When set, the env will be refreshed by re-running this on a timer. */
  refresh?: { everyMs: number; fn: () => Promise<{ env: NodeJS.ProcessEnv }> };
}

export function wrapSpawn(
  adapter: BuiltinAdapter,
  options: CliWrapperOptions,
): ResolvedSpawn;
```

**Settings (additive in `package.json`)**

```jsonc
{
  "acpModelProvider.apiHelper": {
    "type": "object",
    "properties": {
      "command": { "type": "string" },
      "args":    { "type": "array", "items": { "type": "string" } },
      "refreshMs": { "type": "number", "default": 300_000 }
    }
  },
  "acpModelProvider.baseUrl":   { "type": "string" },
  "acpModelProvider.authToken": { "type": "string" },
  "acpModelProvider.agentEnvOverride": { "type": "object" }
}
```

**Behaviour contract**

- The wrapper is **read-only** with respect to the adapter's `cliCommand` and `cliArgs`; it never rewrites them.
- The wrapper **never** reads the keychain or `~/.claude/`. It only consults the settings above.
- `authToken` is never logged.

**Success criteria**

- `cd apps/extension && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd apps/extension && npx vitest run src/discovery/cliWrapper.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 5 files changed

**Output contract** — same shape as task 01.
