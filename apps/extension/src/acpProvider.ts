import * as vscode from "vscode";
import { AgentManager } from "./agentManager";
import { AcpClient } from "./acp";
import type {
  ModelInfo,
  PromptRequest,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
  AgentMessageChunk,
  ContentPart,
} from "./acp";

function makeModelId(agentId: string, model: ModelInfo): string {
  return `${agentId}:${model.id}`;
}

export function toLmModel(
  agentId: string,
  agentLabel: string,
  model: ModelInfo,
  prefix: string
): vscode.LanguageModelChatInformation {
  // Use model metadata if available, otherwise use defaults
  const maxInputTokens = model.maxInputTokens || 200_000;
  const maxOutputTokens = model.maxOutputTokens || 8_192;
  
  return {
    id: makeModelId(agentId, model),
    name: `${prefix} / ${agentLabel} / ${model.name}`,
    family: agentId,
    version: "1",
    maxInputTokens,
    maxOutputTokens,
    detail: model.description ?? agentLabel,
    tooltip: `${agentLabel} via ACP — ${model.id}`,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    // Pricing metadata from models.dev
    ...(model.inputCost && { inputCost: model.inputCost }),
    ...(model.outputCost && { outputCost: model.outputCost }),
    ...(model.cacheCost && { cacheCost: model.cacheCost }),
    ...(model.cacheWriteCost && { cacheWriteCost: model.cacheWriteCost }),
  };
}

function vscodeMessageToAcp(msg: vscode.LanguageModelChatRequestMessage): ContentPart[] {
  const parts: ContentPart[] = [];
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
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    console.log(`[ACP] provideLanguageModelChatInformation called, silent: ${_options.silent}`);
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const agent of this._manager.agents.values()) {
      if (!agent.connected) continue;
      for (const model of agent.models) {
        const lmModel = toLmModel(agent.config.id, agent.config.label, model, this._prefix);
        console.log(`[ACP] Adding model: ${lmModel.id} - ${lmModel.name}`);
        models.push(lmModel);
      }
    }
    console.log(`[ACP] provideLanguageModelChatInformation returning ${models.length} models`);
    console.log(`[ACP] Model IDs: ${models.map(m => m.id).join(', ')}`);

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
    console.log(`[ACP] provideLanguageModelChatResponse called - model: ${model.id}, messages: ${messages.length}`);
    const { agentId, rawModelId, config } = this._parseModelId(model.id);
    console.log(`[ACP] Parsed - agentId: ${agentId}, rawModelId: ${rawModelId}, config: ${config.cliCommand}`);

    const acpClient = new AcpClient();
    const cts = new vscode.CancellationTokenSource();

    token.onCancellationRequested(() => {
      acpClient.sessionCancel(agentId);
      cts.cancel();
    });

    const toolCalls = new Map<string, ToolCall>();
    const responsePromise = new Promise<void>((resolve) => {
      acpClient.on("session/update", (params) => {
        console.log(`[ACP] Session update: ${params.update.sessionUpdate}`);
        this._handleSessionUpdate(params, progress, toolCalls);
        // Resolve when we get an agent_message_chunk
        if (params.update.sessionUpdate === "agent_message_chunk") {
          resolve();
        }
      });
    });

    try {
      console.log(`[ACP] Connecting to ${config.cliCommand} ${config.cliArgs?.join(' ')}`);
      await acpClient.connect(config.cliCommand, config.cliArgs ?? ["--acp"]);

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      console.log(`[ACP] Creating session with cwd: ${cwd}`);
      const { sessionId, configOptions } = await acpClient.sessionNew({ cwd, mcpServers: [] });
      console.log(`[ACP] Session created: ${sessionId}, configOptions: ${configOptions?.length || 0}`);

      // Try to set the model via config option if available
      if (configOptions) {
        const modelConfig = configOptions.find(opt => opt.id === 'model');
        if (modelConfig) {
          console.log(`[ACP] Setting model to ${rawModelId} via config option`);
          await acpClient.sessionSetConfigOption({ sessionId, configId: 'model', value: rawModelId });
        } else {
          console.log(`[ACP] Available config options: ${configOptions.map(o => o.id).join(', ')}`);
        }
      }

      // Send all messages in the conversation
      for (const msg of messages) {
        console.log(`[ACP] Sending message with ${msg.content.length} parts`);
        const acpParams: PromptRequest = {
          sessionId,
          prompt: vscodeMessageToAcp(msg),
        };
        await acpClient.sessionPrompt(acpParams);
      }
      console.log(`[ACP] All messages sent`);

      // Wait for response notification (with timeout)
      console.log(`[ACP] Waiting for response notification...`);
      await Promise.race([responsePromise, new Promise(resolve => setTimeout(resolve, 10000))]);
      console.log(`[ACP] Response received or timeout`);
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
    console.log(`[ACP] provideTokenCount called`);
    const str = typeof text === "string" ? text : this._messageToString(text);
    const count = Math.ceil(str.length / 4);
    console.log(`[ACP] provideTokenCount returning: ${count}`);
    return Promise.resolve(count);
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
    params: SessionNotification,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    toolCalls: Map<string, ToolCall>
  ): void {
    console.log(`[ACP] _handleSessionUpdate called: ${params.update.sessionUpdate}`);
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const chunk = update as AgentMessageChunk;
        for (const part of chunk.content ?? []) {
          this._reportContentPart(part, progress);
        }
        break;
      }

      case "tool_call": {
        const tc = update as ToolCall;
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
        const upd = update as ToolCallUpdate;
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
    part: ContentPart,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    console.log(`[ACP] _reportContentPart called: type=${part.type}`);
    if (part.type === "text") {
      console.log(`[ACP] Reporting text part: ${part.text.substring(0, 50)}...`);
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
