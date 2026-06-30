# ACP Model Provider for VS Code

> ⚠️ **Temporary testing solution** — extension is published to GitHub Releases as a pre-release.
> When stable, it will be published to the VS Code Marketplace.

Expose any [ACP (Agent Client Protocol)](https://agentclientprotocol.com)-compatible AI coding agent as a native chat model in VS Code's Copilot Chat — no vendor lock-in, just plug in your agent and go.

> Think of this as "Zed Agents for VS Code": your ACP agent (Claude Code, Gemini CLI, Codex, OpenCode, …) becomes selectable directly in the VS Code model picker and participates in Copilot Chat natively.

## Packages

This monorepo is organised as independently publishable npm packages:

| Package | Purpose |
|---|---|
| `apps/extension` | Thin VS Code shell (~100 LOC at first). The only file that imports `vscode` at runtime. |
| `@theplenkov/acpify` | The core library — turn any CLI or API into an ACP-compatible agent. Agent-agnostic. |
| `@theplenkov/claude-config` | Claude Code config resolver: env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`), settings.json, CLAUDE.md paths. |
| `@theplenkov/claude-acp` | The Claude Code ACP adapter: `cliCommand: "claude"`, `cliArgs: ["--acp"]`, model mapping. |

Each per-agent adapter (one package per agent) follows the `<agent>-acp` naming — e.g. `gemini-acp`, `codex-acp`, `kilo-acp` — so any editor can depend on whichever agents it wants without pulling in the rest. See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Install

### Quick install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/ThePlenkov/vscode-model-provider/main/scripts/install-from-github.sh | bash
```

This downloads the latest pre-release `.vsix` from GitHub Releases and installs it into your VS Code.

### Manual install

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/ThePlenkov/vscode-model-provider/releases/latest)
2. Run `code --install-extension vscode-model-provider-latest.vsix`

### Local development

```bash
git clone https://github.com/ThePlenkov/vscode-model-provider.git
cd vscode-model-provider
npm install
npm run compile
npx @vscode/vsce package
code --install-extension vscode-model-provider-*.vsix
```

### Uninstall

```bash
code --uninstall-extension theplenkov.vscode-model-provider
```

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code / Copilot Chat                    │
│                                                               │
│   Model picker → ACP / Claude Code / Claude 3.5 Sonnet       │
│                  ACP / Gemini CLI / Gemini 2.0 Flash            │
│                  ACP / Codex CLI / o4-mini                    │
│                                                               │
│   Chat request → LanguageModelChatProvider API                │
│                                                               │
│            ┌─────────────────────────┐                       │
│            │   ACP Model Provider     │  ← this extension     │
│            └────────────┬────────────┘                       │
│                          │ spawn + JSON-RPC/stdio              │
│               ┌──────────┼──────────────────┐                │
│               ▼          ▼                  ▼                │
│         Claude Code   Gemini CLI        Codex CLI             │
│         `--acp`       `--exp-acp`       `--acp`             │
└──────────────────────────────────────────────────────────────┘
```

## Supported Agents

Any agent implementing ACP works, including:

| Agent | Install | CLI args |
|-------|---------|----------|
| GitHub Copilot CLI | `npm i -g @github/copilot` | `copilot --acp --stdio` |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude --acp` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini --experimental-acp` |
| Qwen Code | `npm i -g @qwen-code/qwen-code` | `qwen-code --acp` |
| OpenCode | `npm i -g opencode-ai` | `opencode acp` |
| Codex CLI | `npm i -g @zed-industries/codex-acp` | `codex --acp` |
| Kiro CLI | `brew install kiro-dev/tap/kiro` | `kiro-cli acp` |

## Configure agents

Open **Settings → ACP Model Provider → Agents** to configure which agents are enabled.

```json
{
  "acpModelProvider.agents": [
    {
      "id": "claude-code",
      "label": "Claude Code",
      "cliCommand": "claude",
      "cliArgs": ["--acp"],
      "enabled": true
    }
  ]
}
```

## Pick your model

Open Copilot Chat, click the model picker (top right of the chat panel), and select an ACP agent model — e.g. `ACP / Claude Code / Claude 3.5 Sonnet`.

## Architecture

```
src/
├── acp/
│   ├── types.ts        All ACP protocol types (JSON-RPC 2.0, init, session/*)
│   ├── client.ts       AcpClient: spawn stdio process, JSON-RPC send/recv, events
│   └── index.ts
├── agentManager.ts     AgentManager: PATH discovery, connect-to-discover
├── acpProvider.ts      AcpModelProvider: implements LanguageModelChatProvider
└── extension.ts        Entry point + register provider + manage command
.github/workflows/
└── ci.yml              CI: compile → vsce package → GitHub Release
scripts/
└── install-from-github.sh   One-liner install from latest GitHub Release
```

### Key design decisions

- **Ephemeral sessions**: each chat turn spawns a fresh ACP process and `session/new`. No persistent daemon required.
- **PATH discovery**: on activation, the extension checks which agent CLIs are on PATH and only connects to those that are available.
- **Model ID format**: `<agent-id>:<raw-model-id>` — e.g. `claude-code:claude-3-5-sonnet-20241022`.

## Known Limitations

- Model metadata (max tokens, vision support) is estimated — ACP doesn't expose this in `initialize` yet.
- Tool call execution: the provider reports tool calls to VS Code via `LanguageModelToolCallPart`.
- Persistent sessions (multi-turn memory) are not yet implemented — each turn starts a fresh session.
- `authenticate`: if your agent requires auth (e.g. API key), implement the `authenticate` round-trip in `agentManager.ts`.

## Publishing

| Environment | Target | Trigger |
|------------|--------|---------|
| Testing | GitHub Releases (pre-release) | Every push to `main` |
| Production | VS Code Marketplace / Open VSX | Manual via `publish` job |

## Contributing

PRs welcome. Main areas to extend:

1. **Auth flow** — implement `authenticate()` in `AgentManager` for agents requiring API keys
2. **Persistent sessions** — replace ephemeral sessions with a long-lived process pool in `AgentManager`
3. **Tool result streaming** — the `tool_call_update` handler can accumulate partial results
4. **Better model metadata** — parse capabilities from the `initialize` response

## References

- [VS Code LanguageModelChatProvider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview)
- [GitHub Copilot ACP Server Reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [vscode-acp extension](https://github.com/formulahendry/vscode-acp) — inspiration for ACP stdio handling
