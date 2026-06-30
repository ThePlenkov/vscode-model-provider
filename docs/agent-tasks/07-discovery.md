# Task 07 — PATH discovery + builtin adapter table

> **Do not rewrite.** Use `node:child_process.execFile` for `command -v` /
> `where`. Do not pull in `which` or `node-which` — Node's `execFile` does
> the job.

**Role:** patcher subagent.

**Allowed scope**

- create: `packages/acpify/src/discovery/{pathScout.ts,builtinAdapters.ts,discovery.ts,discovery.test.ts}`
- create: `packages/claude-acp/src/index.ts` (Claude adapter: `cliCommand: "claude"`, `cliArgs: ["--acp"]`, model map; exports `adapter` and `mapModelId`)
- edit:   `apps/extension/package.json` (add `configuration` schema for the new settings; see §Settings below)
- edit:   `packages/acpify/src/index.ts` (re-export the discovery layer)

**Forbidden scope**

- `packages/acpify/src/session/`, `packages/acpify/src/capabilities/`
- `packages/acpify/src/provider/` (PR 09)
- `packages/claude-config/` (PR 10)
- `tests/fixtures/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Module map
2. `docs/specs.md` §Other ACP agents (the adapter table)
3. `node:child_process.execFile` for `command -v` / `where`

**TDD order (mandatory)**

1. **RED.** Write `discovery.test.ts` with the five tests in §Required tests.
2. **GREEN.**
3. **REFACTOR.**

**Required tests**

- **`command -v` selection on POSIX.** Mock `execFile`; on `process.platform === "linux"` the bridge calls `["sh","-c","command -v claude"]`.
- **`where` selection on Windows.** Same, with `["cmd","/c","where","claude"]`.
- **Path-scout timeout.** A mock `execFile` that never resolves; the bridge returns `false` after a configurable timeout (default 5 s).
- **Adapter table returns the documented 7 agents.** The default table contains `claude-code`, `gemini-cli`, `github-copilot-cli`, `opencode`, `codex-acp`, `qwen-code`, `kiro-cli`.
- **`autoDiscover: true` is honoured.** Given a fake PATH with `claude` and `gemini` only, `discover()` returns exactly those two adapters as "connected".

**Public surface**

```ts
// pathScout.ts
export function isOnPath(cmd: string, options?: { timeoutMs?: number }): Promise<boolean>;

// builtinAdapters.ts
export interface BuiltinAdapter {
  id: string;                 // "claude-code", "gemini-cli", …
  label: string;              // "Claude Code", "Gemini CLI", …
  cliCommand: string;         // "claude", "gemini", …
  cliArgs: string[];          // ["--acp"], ["--experimental-acp"], …
  homepage: string;
}
export const BUILTIN_ADAPTERS: readonly BuiltinAdapter[];

// discovery.ts
export interface DiscoveryResult { adapter: BuiltinAdapter; available: boolean; }
export function discover(
  configAdapters: BuiltinAdapter[],
  options?: { autoDiscover?: boolean; scoutTimeoutMs?: number },
): Promise<DiscoveryResult[]>;
```

**Settings (added to `contributes.configuration` in `package.json`)**

```jsonc
{
  "acpModelProvider.agents": {
    "type": "array",
    "items": { "$ref": "#/items/properties/…" },  // existing schema, extended below
    "default": []
  },
  "acpModelProvider.autoDiscover": { "type": "boolean", "default": true },
  "acpModelProvider.scoutTimeoutMs": { "type": "number", "default": 5000 }
}
```

The barebone (this PR) does **not** read the settings yet; PR 09 does.

**Behaviour contract**

- `cliArgs` is read-only. The discovery layer never mutates the adapter.
- `BUILTIN_ADAPTERS` is exported as `as const` so consumers can type-narrow.
- On Windows, the bridge uses `where` (case-insensitive match); on POSIX, `command -v` (case-sensitive). Tests assert the platform branch.

**Success criteria**

- `cd packages/acpify && npx tsc --noEmit -p tsconfig.json` exits 0
- `cd packages/acpify && npx vitest run src/discovery/discovery.test.ts` exits 0
- `git diff --stat base/barebone..HEAD` shows ≤ 5 files changed

**Output contract** — same shape as task 01.
