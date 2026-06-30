import { execFile } from "child_process";
import { promisify } from "util";
import { EventEmitter } from "events";
import { AcpClient } from "./acp";
import type { ModelInfo } from "./acp";

const execFileAsync = promisify(execFile);

// ─── Config shape ────────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  label: string;
  cliCommand: string;
  cliArgs?: string[];
  enabled?: boolean;
  modelMapping?: Record<string, string>; // Maps model IDs to aliases
}

// ─── Discovered agent state ──────────────────────────────────────────────────

export interface DiscoveredAgent {
  config: AgentConfig;
  /** True once `connect()` completes without error. */
  connected: boolean;
  /** Models returned by the agent during the ACP `initialize` handshake. */
  models: ModelInfo[];
  /** Stderr output from the last discovery attempt (for diagnostics). */
  lastError?: string;
}

// ─── Active session for a chat turn ─────────────────────────────────────────

export interface ActiveSession {
  agentId: string;
  sessionId: string;
  client: AcpClient;
}

// ─── AgentManager ────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of ACP agents:
 *  - discovers available agents from VS Code config + PATH availability
 *  - runs short-lived `connect()` calls to extract model lists
 *  - maintains a pool of `AcpClient` instances for active chat sessions
 */
export class AgentManager extends EventEmitter {
  /** Map: agent-config-id → discovered agent metadata */
  private _agents = new Map<string, DiscoveredAgent>();

  /** Active persistent sessions, keyed by agent-config-id. */
  private _sessions = new Map<string, ActiveSession>();

  private _initialized = false;

  get agents(): Map<string, DiscoveredAgent> {
    return this._agents;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Read the `acpModelProvider.agents` config, verify which CLIs are on PATH,
   * then connect to each one briefly to extract model info.
   */
  async initialize(configuredAgents: AgentConfig[]): Promise<void> {
    await Promise.allSettled(
      configuredAgents
        .filter((a) => a.enabled !== false)
        .map((config) => this._discoverAgent(config))
    );
    this._initialized = true;
  }

  /**
   * Return all models across all successfully connected agents.
   * Each model is prefixed with its agent ID to ensure uniqueness in VS Code.
   */
  getAllModels(): Array<{
    agentId: string;
    model: ModelInfo;
  }> {
    const result: Array<{ agentId: string; model: ModelInfo }> = [];
    for (const [agentId, agent] of this._agents) {
      if (!agent.connected) continue;
      for (const model of agent.models) {
        result.push({ agentId, model });
      }
    }
    return result;
  }

  /**
   * Get a fresh `AcpClient` + `session/new` for the given model.
   * Caller is responsible for calling `client.disconnect()` when done.
   */
  async createSession(
    modelId: string
  ): Promise<{ client: AcpClient; sessionId: string }> {
    const { agentId, rawModelId, config } = this.resolveModelConfig(modelId);
    const client = new AcpClient();
    await client.connect(config.cliCommand, config.cliArgs ?? ["--acp"]);
    const { sessionId } = await client.sessionNew({
      cwd: process.cwd(),
      mcpServers: [],
    });
    return { client, sessionId };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async _discoverAgent(config: AgentConfig): Promise<void> {
    // Check if the CLI is available on PATH
    const available = await this._isOnPath(config.cliCommand);
    if (!available) {
      this._agents.set(config.id, {
        config,
        connected: false,
        models: [],
        lastError: `CLI '${config.cliCommand}' not found on PATH`,
      });
      return;
    }

    // Connect briefly to extract model list
    const client = new AcpClient();
    try {
      await this._withTimeout(client.connect(config.cliCommand, config.cliArgs ?? ["--acp"]), 15_000);
      this._agents.set(config.id, {
        config,
        connected: true,
        models: [...client.discoveredModels],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._agents.set(config.id, {
        config,
        connected: false,
        models: [],
        lastError: msg,
      });
    } finally {
      client.disconnect();
    }
  }

  /** Check if a binary exists on PATH without throwing. */
  private async _isOnPath(cmd: string): Promise<boolean> {
    try {
      // `command -v` works on macOS/Linux, `where` on Windows
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const args =
        process.platform === "win32" ? ["/c", "where", cmd] : ["-c", `command -v ${cmd}`];
      await execFileAsync(shell, args, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Parse `<agent-id>:<model-id>` → { agentId, modelId }. */
  /**
   * Return the config for a given model ID.
   * Throws if the model ID format is wrong or the agent is unknown.
   */
  resolveModelConfig(
    modelId: string
  ): { agentId: string; rawModelId: string; config: { cliCommand: string; cliArgs?: string[] } } {
    const colonIdx = modelId.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Model ID '${modelId}' does not match the '<agent-id>:<model-id>' convention`
      );
    }
    const agentId = modelId.slice(0, colonIdx);
    const rawModelId = modelId.slice(colonIdx + 1);

    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' is not configured`);
    }
    if (!agent.connected) {
      throw new Error(`Agent '${agentId}' is not connected: ${agent.lastError ?? "unknown"}`);
    }

    return {
      agentId,
      rawModelId,
      config: { cliCommand: agent.config.cliCommand, cliArgs: agent.config.cliArgs },
    };
  }

  private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      promise
        .then((v) => {
          clearTimeout(timer);
          resolve(v);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }
}
