# ACP Model Provider for VS Code

Expose any [ACP (Agent Client Protocol)](https://agentclientprotocol.com)-compatible AI coding agent as a native chat model in VS Code's Copilot Chat — no vendor lock-in, just plug in your agent and go.

> Think of this as "Zed Agents for VS Code": your ACP agent (Claude Code, Gemini CLI, Codex, OpenCode, …) becomes selectable directly in the VS Code model picker and participates in Copilot Chat natively.

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code / Copilot Chat                    │
│                                                               │
│   Model picker → ACP / Claude Code / Claude 3.5 Sonnet       │
│                  ACP / Gemini CLI / Gemini 2.0 Flash           │
│                  ACP / Codex CLI / o4-mini                    │
│                                                               │
│   Chat request → LanguageModelChatProvider API                │
│                                                               │
│            ┌─────────────────────────┐                       │
│            │   ACP Model Provider    │  ← this extension     │
│            │     (acpProvider.ts)    │                       │
│            └────────────┬────────────┘                       │
│                          │ spawn + JSON-RPC/stdio             │
│               ┌──────────┼──────────────────┐                │
│               ▼          ▼                  ▼                │
│         Claude Code   Gemini CLI        Codex CLI              │
│         `--acp`       `--exp-acp`       `--acp`               │
└──────────────────────────────────────────────────────────────┘
```

The extension implements the VS Code `LanguageModelChatProvider` API and bridges it to the ACP protocol — a JSON-RPC 2.0 interface over stdio used by modern AI coding agents.

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

## Install

### Option A: Global npm install (recommended)

```bash
npm install -g vscode-model-provider
```

That's it. The `postinstall` script:
1. Compiles TypeScript
2. Packages a `.vsix`
3. Installs it into your VS Code automatically

Restart VS Code, then open Copilot Chat → model picker → `ACP / <Agent> / <Model>`.

> **Prerequisites:** `code` CLI must be on your PATH. Install from
> [code.visualstudio.com/docs/editor/command-line](https://code.visualstudio.com/docs/editor/command-line).

### Option B: Manual / local development

```bash
git clone https://github.com/ThePlenkov/vscode-model-provider.git
cd vscode-model-provider
npm install
npm run install:vsix     # compile + package + install

# or step by step:
npm run compile          # TypeScript → out/
npx vsce package         # → vscode-model-provider.vsix
code --install-extension vscode-model-provider.vsix
```

### Update

```bash
npm update -g vscode-model-provider
```

### Uninstall

```bash
code --uninstall-extension theplenkov.vscode-model-provider
npm uninstall -g vscode-model-provider
```

## Configure agents

Open **Settings → ACP Model Provider → Agents** and ensure your agents are listed. The default config already includes the most common agents.

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
scripts/
└── self-install.js     postinstall: compile → vsce package → code --install-extension
```

### Key design decisions

- **Ephemeral sessions**: each chat turn spawns a fresh ACP process and `session/new`. No persistent daemon required.
- **PATH discovery**: on activation, the extension checks which agent CLIs are on PATH and only connects to those that are available.
- **Model ID format**: `<agent-id>:<raw-model-id>` — e.g. `claude-code:claude-3-5-sonnet-20241022`. This ensures uniqueness across multiple agents.

## Known Limitations

- Model metadata (max tokens, vision support) is estimated — ACP doesn't expose this in `initialize` yet.
- Tool call execution: the provider reports tool calls to VS Code via `LanguageModelToolCallPart`.
- Persistent sessions (multi-turn memory) are not yet implemented — each turn starts a fresh session.
- `authenticate`: if your agent requires auth (e.g. API key), implement the `authenticate` round-trip in `agentManager.ts`.

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
