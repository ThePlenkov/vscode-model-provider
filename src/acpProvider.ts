import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import {
  AcpClient,
  AcpContentPart,
  AcpMessageChunk,
  AcpModelInfo,
  AcpSessionPromptParams,
  AcpSessionUpdateParams,
  AcpToolCall,
} from "./acp";

/**
 * Derive a unique, stable model ID for the VS Code model picker.
 * Format: `<agent-id>:<model-id>` e.g. `claude-code:claude-3-5-sonnet-20241022`
 */
function makeModelId(agentId: string, model: AcpModelInfo): string {
  return `${agentId}:${model.id}`;
}

/**
 * Convert a model info object from ACP into a VS Code `LanguageModelChatInformation`.
 */
function toLmModel(
  agentId: string,
  agentLabel: string,
  model: AcpModelInfo,
  prefix: string
): vscode.LanguageModelChatInformation {
  return {
    id: makeModelId(agentId, model),
    name: `${prefix} / ${agentLabel} / ${model.name}`,
    family: agentId,
    version: "1",
    maxInputTokens: 128_000, // ACP agents don't expose this in init — use a safe default
    maxOutputTokens: 32_768,
    detail: model.description ?? agentLabel,
    tooltip: `${agentLabel} via ACP — ${model.id}`,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  };
}

/**
 * Convert VS Code `LanguageModelChatMessage` → ACP `AcpContentPart[]`.
 * Skips tool-result parts (those are sent via the tool_call notification path).
 */
function vscodeMessageToAcp(msg: vscode.LanguageModelChatRequestMessage): AcpContentPart[] {
  const parts: AcpContentPart[] = [];
  for (const part of msg.content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
    } else if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: "text", text: part.value });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      // Images: base64-encode for ACP compatibility
      const b64 = Buffer.from(part.data).toString("base64");
      parts.push({ type: "image", data: b64, mimeType: part.mimeType });
    }
    // LanguageModelToolCallPart and LanguageModelToolResultPart are handled
    // via the tool_call notification path, not as prompt content
  }
  return parts;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AcpModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  private readonly _manager: AgentManager;
  private readonly _prefix: string;

  constructor(manager: AgentManager, displayPrefix = "ACP") {
    this._manager = manager;
    this._prefix = displayPrefix;
  }

  /**
   * Return every model from every connected ACP agent.
   * Called by VS Code when opening the model picker.
   */
  provideLanguageModelChatInformation(
    _options: { silent: boolean },
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const agent of this._manager.agents.values()) {
      if (!agent.connected) continue;
      for (const model of agent.models) {
        models.push(toLmModel(agent.config.id, agent.config.label, model, this._prefix));
      }
    }

    // If no agents are connected yet, return a placeholder so VS Code
    // doesn't grey out the vendor entirely.
    if (models.length === 0) {
      models.push({
        id: "acp:no-agent",
        name: `${this._prefix} — No ACP agents found`,
        family: "acp",
        version: "1",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        detail: "Install an ACP-compatible agent (Claude Code, Gemini CLI, etc.) and enable it in settings",
        tooltip: "No ACP agents are currently available",
        capabilities: { toolCalling: false, imageInput: false },
      });
    }

    return models;
  }

  /**
   * Handle a single chat turn.
   *
   * Flow per VS Code call:
   *  1. Parse model ID → resolve agent + raw-model-id
   *  2. Spawn a fresh ACP client for this turn (ephemeral, short-lived)
   *  3. `session/new` with the target model
   *  4. `session/prompt` with VS Code messages
   *  5. Forward `session/update` notifications → `progress.report(...)`
   *  6. Return when `stopReason` arrives
   *
   * Each user message gets a fresh session. This keeps each turn independent
   * and avoids stale state — a limitation that can be lifted with persistent
   * sessions in a future iteration.
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const { agentId, rawModelId, config } = this._parseModelId(model.id);

    // The last message is the current user request; prior messages are history.
    const currentMsg = messages[messages.length - 1];

    const acpClient = new AcpClient();
    const cts = new vscode.CancellationTokenSource();

    // Forward cancellation back to the ACP agent
    token.onCancellationRequested(() => {
      acpClient.sessionCancel(agentId); // best-effort
      cts.cancel();
    });

    // Track tool call IDs so we can route results back
    const toolCalls = new Map<string, AcpToolCall>();

    // Forward session/update → VS Code progress
    acpClient.on("session/update", (params) => {
      this._handleSessionUpdate(params, progress, toolCalls);
    });

    try {
      // 1. Connect to the agent
      await acpClient.connect(config.cliCommand, config.cliArgs ?? ["--acp"]);

      // 2. New session with the target model
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const { sessionId } = await acpClient.sessionNew({ cwd, model: rawModelId });

      // 3. Build the ACP prompt from the current user message
      const acpParams: AcpSessionPromptParams = {
        sessionId,
        prompt: vscodeMessageToAcp(currentMsg),
      };

      // 4. Send prompt — this streams back via session/update notifications
      await acpClient.sessionPrompt(acpParams);
    } finally {
      acpClient.disconnect();
      cts.dispose();
    }
  }

  /**
   * Estimate token count. Uses a rough heuristic: ~4 chars ≈ 1 token.
   */
  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    const str = typeof text === "string" ? text : this._messageToString(text);
    return Promise.resolve(Math.ceil(str.length / 4));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _parseModelId(
    id: string
  ): { agentId: string; rawModelId: string; config: { cliCommand: string; cliArgs?: string[] } } {
    const colonIdx = id.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `[AcpModelProvider] Unexpected model ID format: '${id}'. ` +
          `Expected '<agent-id>:<model-id>'.`
      );
    }
    const agentId = id.slice(0, colonIdx);
    const rawModelId = id.slice(colonIdx + 1);

    const agent = this._manager.agents.get(agentId);
    if (!agent) {
      throw new Error(`[AcpModelProvider] Unknown agent id: '${agentId}'`);
    }

    return {
      agentId,
      rawModelId,
      config: {
        cliCommand: agent.config.cliCommand,
        cliArgs: agent.config.cliArgs,
      },
    };
  }

  private _handleSessionUpdate(
    params: AcpSessionUpdateParams,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    toolCalls: Map<string, AcpToolCall>
  ): void {
    const p = params;

    if (p.type === "message") {
      const chunk = p as AcpMessageChunk;
      for (const part of chunk.content) {
        if (part.type === "text") {
          progress.report(new vscode.LanguageModelTextPart(part.text));
        }
        if (part.type === "image") {
          try {
            const binary = Buffer.from(part.data, "base64");
            progress.report(
              new vscode.LanguageModelDataPart(binary, part.mimeType ?? "image/png")
            );
          } catch {
            // Skip malformed image parts
          }
        }
      }
    } else if (p.type === "tool_call") {
      const tc = p as AcpToolCall;
      toolCalls.set(tc.callId, tc);
      // Parse tool input (may arrive as a JSON string from some agents)
      let input: object;
      try {
        input = typeof tc.input === "string" ? JSON.parse(tc.input) : (tc.input ?? {});
      } catch {
        input = tc.input ?? {};
      }
      progress.report(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, input));
    } else if (p.type === "tool_call_update") {
      // Accumulate partial streamed tool results
      const upd = p as { callId: string; content: AcpContentPart[] };
      for (const part of upd.content) {
        if (part.type === "text") {
          progress.report(new vscode.LanguageModelTextPart(part.text));
        }
      }
    }
    // Other notification types (session_end, mode_change, available_commands, plan)
    // are intentionally ignored in this initial implementation.
  }

  private _messageToString(msg: vscode.LanguageModelChatRequestMessage): string {
    return msg.content
      .map((part): string => {
        if (part instanceof vscode.LanguageModelTextPart) return part.value;
        if (typeof part === "string") return part;
        return "";
      })
      .join("")
      .trim();
  }
}
