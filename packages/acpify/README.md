# `@theplenkov/acpify`

Agent-agnostic core for the [Agent Client Protocol](https://agentclientprotocol.com).
Used by editor extensions (VS Code today, Cursor / Kilo / others later) to expose
ACP-compatible coding agents as native chat models.

## Invariants

- **No runtime `import "vscode"`.** This package's `client/`, `session/`, and
  `discovery/` modules do not depend on VS Code at runtime. The only places
  `vscode` is imported are the capability bridges (`capabilities/`) and the
  provider (`provider/`) — and only via `import type`, because they implement
  VS Code-specific contracts.
- **Do not rewrite upstream libs.** This package depends on
  `@agentclientprotocol/sdk` for JSON-RPC framing, typed notifications, and
  the `ClientSideConnection` wrapper. We do not reimplement any of that.
- **Agent-agnostic.** No Claude-specific env vars, no Gemini-specific flags,
  no Codex-specific paths. Those live in `packages/adapter-*` and
  `packages/claude-config`.

## Layout

```
src/
├── client/                  # stdio JSON-RPC client over @agentclientprotocol/sdk
│   ├── cliClient.ts         # (PR 01)
│   └── streamBridge.ts      # (PR 01)
├── session/                 # persistent per-(agent,cwd) session pool
│   ├── sessionPool.ts       # (PR 02)
│   ├── acpSession.ts        # (PR 02)
│   └── permissions.ts       # (PR 02 / PR 05)
├── capabilities/            # reverse-call handlers
│   ├── vscodeFsBridge.ts    # (PR 03) — imports vscode
│   ├── vscodeTerminalBridge.ts  # (PR 04) — imports vscode
│   ├── vscodePermissionBridge.ts (PR 05) — imports vscode
│   └── vscodeElicitationBridge.ts (PR 06) — imports vscode
├── discovery/               # PATH scout + builtin adapter table
│   ├── pathScout.ts         # (PR 07)
│   ├── builtinAdapters.ts   # (PR 07)
│   └── cliWrapper.ts        # (PR 10)
├── provider/                # VS Code LanguageModelChatProvider impl
│   └── acpProvider.ts       # (PR 09) — imports vscode
└── index.ts                 # public exports
```

## Status (barebone)

- `provider/barebone` exists as the minimum compileable `LanguageModelChatProvider`
  impl that exposes 0 models. This proves the package shape, build, and
  activation flow work end-to-end.
- All other modules are added by the per-PR subagent tasks in
  `docs/agent-tasks/`.