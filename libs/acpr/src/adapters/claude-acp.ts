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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  private cachedModels: ModelInfo[] | null = null;

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
    try {
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
    } catch (error) {
      console.error('claude-acp: Error in initialize:', error);
      // Return fallback on error
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          prompts: true,
          streaming: false,
          tools: false,
        },
        models: this.getFallbackModels(),
      };
    }
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
    if (this.cachedModels) {
      return this.cachedModels;
    }
    
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const settingsContent = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);
      
      if (settings.availableModels && settings.availableModels.length > 0) {
        this.cachedModels = settings.availableModels.map((modelId: string) => ({
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
        return this.cachedModels;
      }
    } catch (error) {
      // Fallback to default models
    }
    
    this.cachedModels = this.getFallbackModels();
    return this.cachedModels;
  }

  async getFallbackModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'claude-3-5-sonnet-20241022',
        capabilities: {
          text: true,
          images: false,
          tools: true,
        },
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        description: 'claude-3-5-haiku-20241022',
        capabilities: {
          text: true,
          images: false,
          tools: true,
        },
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
      }
    ];
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
const output = Readable.toWeb(process.stdin);

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
