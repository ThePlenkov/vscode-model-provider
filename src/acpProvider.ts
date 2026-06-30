import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import {
  AcpClient,
  AcpContentPart,
  AcpModelInfo,
  AcpPromptParams,
  AcpSessionNotification,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpAgentMessageChunk,
} from "./acp";

function makeModelId(agentId: string, model: AcpModelInfo): string {
  return `${agentId}:${model.id}`;
}

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
    maxInputTokens: 128_000,
    maxOutputTokens: 32_768,
    detail: model.description ?? agentLabel,
    tooltip: `${agentLabel} via ACP — ${model.id}`,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  };
}

function vscodeMessageToAcp(msg: vscode.LanguageModelChatRequestMessage): AcpContentPart[] {
  const parts: AcpContentPart[] = [];
  for (const part of msg.content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
    } else if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: "text", text: part.value });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      const b64 = Buffer.from(part.data).toString("base64");
      parts.push({ type: "image", data: b64, mimeType: part.mimeType });
    }
    // LanguageModelToolCallPart / LanguageModelToolResultPart are handled
    // via the session/update tool_call path
  }
  return parts;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AcpModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  constructor(
    private readonly _manager: AgentManager,
    private readonly _prefix = "ACP"
  ) {}

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

    if (models.length === 0) {
      models.push({
        id: "acp:no-agent",
        name: `${this._prefix} — No ACP agents found`,
        family: "acp",
        version: "1",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        detail: "Install an ACP-compatible agent and enable it in settings",
        tooltip: "No ACP agents are currently available",
        capabilities: { toolCalling: false, imageInput: false },
      });
    }

    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const { agentId, rawModelId, config } = this._parseModelId(model.id);
    const currentMsg = messages[messages.length - 1];

    const acpClient = new AcpClient();
    const cts = new vscode.CancellationTokenSource();

    token.onCancellationRequested(() => {
      acpClient.sessionCancel(agentId);
      cts.cancel();
    });

    const toolCalls = new Map<string, AcpToolCall>();

    acpClient.on("session/update", (params) => {
      this._handleSessionUpdate(params, progress, toolCalls);
    });

    try {
      await acpClient.connect(config.cliCommand, config.cliArgs ?? ["--acp"]);

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const { sessionId } = await acpClient.sessionNew({ cwd });

      const acpParams: AcpPromptParams = {
        sessionId,
        prompt: vscodeMessageToAcp(currentMsg),
      };

      await acpClient.sessionPrompt(acpParams);
    } finally {
      acpClient.disconnect();
      cts.dispose();
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    const str = typeof text === "string" ? text : this._messageToString(text);
    return Promise.resolve(Math.ceil(str.length / 4));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _parseModelId(
    id: string
  ): { agentId: string; rawModelId: string; config: { cliCommand: string; cliArgs?: string[] } } {
    const colonIdx = id.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`[AcpModelProvider] Unexpected model ID format: '${id}'. Expected '<agent-id>:<model-id>'.`);
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
      config: { cliCommand: agent.config.cliCommand, cliArgs: agent.config.cliArgs },
    };
  }

  private _handleSessionUpdate(
    params: AcpSessionNotification,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    toolCalls: Map<string, AcpToolCall>
  ): void {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const chunk = update as AcpAgentMessageChunk;
        for (const part of chunk.content ?? []) {
          this._reportContentPart(part, progress);
        }
        break;
      }

      case "tool_call": {
        const tc = update as AcpToolCall;
        toolCalls.set(tc.toolCallId, tc);
        // Adapt to vscode.LanguageModelToolCallPart expected fields
        const name = (tc as unknown as { name?: string }).name ?? "unknown";
        let input: object = {};
        const rawInput = (tc as unknown as { input?: unknown }).input;
        if (typeof rawInput === "string") {
          try { input = JSON.parse(rawInput); } catch { input = {}; }
        } else if (rawInput && typeof rawInput === "object") {
          input = rawInput as object;
        }
        progress.report(new vscode.LanguageModelToolCallPart(tc.toolCallId, name, input));
        break;
      }

      case "tool_call_update": {
        const upd = update as AcpToolCallUpdate;
        for (const part of upd.content ?? []) {
          this._reportContentPart(part, progress);
        }
        break;
      }

      // session_end, plan, available_commands_update, current_mode_update,
      // config_option_update, session_info_update, usage_update — ignored for now
    }
  }

  private _reportContentPart(
    part: AcpContentPart,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    if (part.type === "text") {
      progress.report(new vscode.LanguageModelTextPart(part.text));
    } else if (part.type === "image") {
      try {
        const binary = Buffer.from(part.data, "base64");
        progress.report(new vscode.LanguageModelDataPart(binary, part.mimeType ?? "image/png"));
      } catch {
        // skip malformed image parts
      }
    }
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
