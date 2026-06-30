#!/usr/bin/env node

/**
 * claude-acp - Claude-specific ACP adapter
 * 
 * Translates ACP protocol to Claude Code CLI
 * This is a standalone adapter that can be invoked as:
 *   acpr claude          # via generic acpr CLI
 *   claude-acp         # as standalone command
 */

import { spawn } from 'child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import Anthropic from '@anthropic-ai/sdk';
import claudeConfig, { resolveApiKeyHelper } from 'claude-config';
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  CancelNotification,
  SessionNotification,
  ModelInfo,
  AgentContext,
  AgentMessageChunk,
  ContentPart,
} from '@agentclientprotocol/sdk';

interface AgentSession {
  cwd: string;
  config?: Record<string, string>;
  pendingPrompt?: AbortController;
}

class ClaudeACPAdapter {
  private claudePath: string;
  private anthropic: Anthropic | null = null;
  private sessions: Map<string, AgentSession> = new Map();

  constructor() {
    this.claudePath = this.findClaudePath();
  }

  private findClaudePath(): string {
    if (process.env.CLAUDE_PATH) {
      return process.env.CLAUDE_PATH;
    }
    return 'claude';
  }

  async initializeAnthropic() {
    if (this.anthropic) return this.anthropic;

    const config = await claudeConfig.resolveConfig();
    
    if (config.raw.apiKeyHelper) {
      console.error('claude-acp: Resolving API key helper...');
      const resolvedKey = await resolveApiKeyHelper(config.raw.apiKeyHelper);
      console.error('claude-acp: API key resolved successfully');
      const sdkConfig = config.sdk();
      sdkConfig.apiKey = resolvedKey;
      this.anthropic = new Anthropic(sdkConfig);
    } else {
      this.anthropic = new Anthropic(config.sdk());
    }
    
    return this.anthropic;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    console.error('claude-acp: Initialize request');
    console.error(`claude-acp: Using claude path: ${this.claudePath}`);
    
    const models = await this.getModels();
    
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        prompts: true,
        streaming: false,
        tools: false,
      },
      models,
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    console.error('claude-acp: Session new request');
    
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    
    this.sessions.set(sessionId, { cwd: params.cwd });
    
    return {
      sessionId,
    };
  }

  async authenticate(_params: unknown): Promise<unknown> {
    console.error('claude-acp: Authenticate request');
    return {};
  }

  async setSessionMode(_params: unknown): Promise<unknown> {
    console.error('claude-acp: Set mode');
    return {};
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    console.error('claude-acp: Set config option', params.configId, '=', params.value);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      if (!session.config) session.config = {};
      session.config[params.configId] = params.value;
    }
    return [];
  }

  async prompt(params: PromptRequest, cx: AgentContext): Promise<PromptResponse> {
    console.error('claude-acp: Session prompt request');
    
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    try {
      // Extract text from content parts
      const text = params.prompt
        .filter(p => p.type === 'text')
        .map(p => p.text || '')
        .join('\n');
      
      const result = await this.callClaude(text, session.pendingPrompt.signal);
      
      // Send the response as a text chunk
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: result,
          },
        },
      });
      
      session.pendingPrompt = null;
      
      return {
        stopReason: "end_turn",
      };
    } catch (err) {
      if (session.pendingPrompt?.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      console.error('claude-acp: Claude Code error', err);
      throw err;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    console.error('claude-acp: Session cancel request', params.sessionId);
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async getModels(): Promise<ModelInfo[]> {
    const config = await claudeConfig.resolveConfig();
    
    if (config.raw.availableModels && config.raw.availableModels.length > 0) {
      console.error('claude-acp: Using availableModels from config:', config.raw.availableModels.length, 'model(s)');
      return this.resolveModelMetadata(config.raw.availableModels, config.raw.modelOverrides);
    }
    
    try {
      let apiKey = config.sdk().apiKey;
      if (config.raw.apiKeyHelper) {
        console.error('claude-acp: Resolving API key helper...');
        apiKey = await resolveApiKeyHelper(config.raw.apiKeyHelper);
        console.error('claude-acp: API key resolved successfully');
      }
      
      const baseUrl = config.baseUrl || 'https://api.anthropic.com';
      const openaiBaseUrl = baseUrl.replace('/anthropic/', '/openai/');
      const modelsUrl = `${openaiBaseUrl}models`;
      
      console.error('claude-acp: Fetching models from OpenAI compatibility endpoint:', modelsUrl);
      
      const response = await fetch(modelsUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const modelIds = data.data.map((m: any) => m.id);
      return this.resolveModelMetadata(modelIds, config.raw.modelOverrides);
    } catch (error) {
      console.error('claude-acp: Failed to fetch models from API, using fallback from config:', error);
      return this.getFallbackModels();
    }
  }

  async resolveModelMetadata(modelIds: string[], modelOverrides?: Record<string, string>): Promise<ModelInfo[]> {
    try {
      console.error('claude-acp: Resolving model metadata from models.dev for', modelIds.length, 'model(s)');
      
      const response = await fetch('https://models.dev/api.json');
      if (!response.ok) {
        throw new Error(`Failed to fetch models.dev: ${response.status}`);
      }
      
      const data = await response.json();
      const modelsMap = new Map<string, any>();
      for (const provider of Object.values(data) as any[]) {
        if (provider.models) {
          for (const [id, metadata] of Object.entries(provider.models)) {
            modelsMap.set(id, metadata);
          }
        }
      }
      
      return modelIds.map((modelId: string) => {
        const canonicalId = modelOverrides?.[modelId] || modelId;
        const metadata = modelsMap.get(canonicalId);
        
        const name = metadata?.name || modelId.split('/').pop()?.replace(/-/g, ' ').replace(/_/g, ' ') || modelId;
        const description = metadata?.description || modelId;
        const maxInputTokens = metadata?.limit?.context || 200000;
        const maxOutputTokens = metadata?.limit?.output || 8192;
        
        const cost = metadata?.cost;
        const pricing: any = {};
        if (cost) {
          if (cost.input) pricing.inputCost = cost.input;
          if (cost.output) pricing.outputCost = cost.output;
          if (cost.cache_read) pricing.cacheCost = cost.cache_read;
          if (cost.cache_write) pricing.cacheWriteCost = cost.cache_write;
        }
        
        return {
          id: modelId,
          name,
          description,
          capabilities: {
            text: true,
            images: false,
            tools: true,
          },
          maxInputTokens,
          maxOutputTokens,
          ...pricing,
        };
      });
    } catch (error) {
      console.error('claude-acp: Failed to resolve model metadata, using fallback:', error);
      
      return modelIds.map((modelId: string) => ({
        id: modelId,
        name: modelId.split('/').pop()?.replace(/-/g, ' ').replace(/_/g, ' ') || modelId,
        description: modelId,
        capabilities: {
          text: true,
          images: false,
          tools: true,
        },
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
      }));
    }
  }

  async getFallbackModels(): Promise<ModelInfo[]> {
    const config = await claudeConfig.resolveConfig();
    
    if (config.raw.fallbackModel && config.raw.fallbackModel.length > 0) {
      return this.resolveModelMetadata(config.raw.fallbackModel, config.raw.modelOverrides);
    }
    
    const sonnetModel = config.raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const opusModel = config.raw.env?.ANTHROPIC_DEFAULT_OPUS_MODEL;
    const haikuModel = config.raw.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    
    const modelIds = [];
    if (sonnetModel) modelIds.push(sonnetModel);
    if (opusModel) modelIds.push(opusModel);
    if (haikuModel) modelIds.push(haikuModel);
    
    if (modelIds.length > 0) {
      return this.resolveModelMetadata(modelIds, config.raw.modelOverrides);
    }
    
    return [];
  }

  private async callClaude(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const claude = spawn(this.claudePath, ['-p', prompt], {
        stdio: 'pipe'
      });

      let output = '';
      let errorOutput = '';

      claude.stdout.on('data', (data) => {
        output += data.toString();
      });

      claude.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      claude.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Claude Code exited with code ${code}: ${errorOutput}`));
        }
      });

      claude.on('error', (error) => {
        reject(error);
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          claude.kill();
          reject(new Error('Prompt cancelled'));
        });
      }
    });
  }
}

// Main entry point using SDK
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const stream = acp.ndJsonStream(input, output);
const adapter = new ClaudeACPAdapter();

acp
  .agent({ name: "claude-acp" })
  .onRequest("initialize", (ctx) => adapter.initialize(ctx.params))
  .onRequest("session/new", (ctx) => adapter.newSession(ctx.params))
  .onRequest("authenticate", (ctx) => adapter.authenticate(ctx.params))
  .onRequest("session/set_mode", (ctx) => adapter.setSessionMode(ctx.params))
  .onRequest("session/set_config_option", (ctx) => adapter.setSessionConfigOption(ctx.params))
  .onRequest("session/prompt", (ctx) => adapter.prompt(ctx.params, ctx.client))
  .onNotification("session/cancel", (ctx) => adapter.cancel(ctx.params))
  .connect(stream);

// Export for use as a module
export async function run(args: string[]) {
  // Already started above
}
