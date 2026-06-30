import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as acp from "@agentclientprotocol/sdk";
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

/** Error thrown when an ACP method returns a JSON-RPC error. */
export class AcpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/**
 * ACP (Agent Client Protocol) v1 JSON-RPC 2.0 client over stdio.
 *
 * Usage:
 * ```ts
 * const client = new AcpClient();
 * await client.connect('claude', ['--acp']);
 * // client.agentCapabilities is now populated
 * const { sessionId } = await client.sessionNew({ cwd: process.cwd() });
 * client.on('session/update', (params) => { ... });
 * await client.sessionPrompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
 * ```
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private pending = new Map<number | string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private nextId = 1;
  private _disconnected = false;
  private _stdoutBuffer = "";

  /** Populated after `connect()` resolves. */
  private _protocolVersion: number = 0;
  private _agentCapabilities: acp.AgentCapabilities = {};

  /**
   * Models advertised by the agent during `initialize`.
   * This is a custom extension not in the ACP v1 core spec — some agents
   * (e.g. Claude Code) include a `models` array in the init response.
   */
  private _discoveredModels: acp.ModelInfo[] = [];

  get discoveredModels(): acp.ModelInfo[] {
    return this._discoveredModels;
  }

  get protocolVersion(): number {
    return this._protocolVersion;
  }

  get agentCapabilities(): acp.AgentCapabilities {
    return this._agentCapabilities;
  }

  /** Whether the agent process is running and connected. */
  get isConnected(): boolean {
    return this.proc !== null && !this._disconnected;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Spawn the agent process and run the `initialize` handshake.
   * Negotiates the protocol version and populates `agentCapabilities`.
   */
  connect(
    cliCommand: string,
    cliArgs: string[] = ["--acp"],
    clientInfo?: acp.ClientInfo,
    clientCapabilities?: acp.ClientCapabilities
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this._disconnected = false;

      this.proc = spawn(cliCommand, cliArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
        windowsHide: true,
      });

      if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) {
        reject(new Error("Failed to open stdio streams for ACP agent"));
        return;
      }

      this.proc.on("error", (err) => {
        this._disconnected = true;
        this.emit("disconnect", err);
        reject(err);
      });

      this.proc.on("close", (code) => {
        this._disconnected = true;
        this.emit("close", code);
      });

      this.proc.stderr.on("data", (chunk: Buffer) => {
        this.emit("stderr", chunk.toString());
      });

      this.proc.stdout.on("data", (chunk: Buffer) => {
        this._stdoutBuffer += chunk.toString();
        this._drain();
      });

      const params: InitializeRequest = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities ?? { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo,
      };

      this.sendRequest("initialize", params as unknown as Record<string, unknown>)
        .then((result) => {
          const r = result as InitializeResponse & { models?: acp.ModelInfo[] };
          this._protocolVersion = r.protocolVersion;
          this._agentCapabilities = r.agentCapabilities ?? {};
          if (r.models && Array.isArray(r.models)) {
            this._discoveredModels = r.models;
          }
          this.emit("ready");
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Terminate the agent process gracefully.
   */
  disconnect(): void {
    if (this.proc && !this._disconnected) {
      this._disconnected = true;
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────

  async sessionNew(params: NewSessionRequest): Promise<NewSessionResponse> {
    return (await this.sendRequest(
      "session/new",
      params as unknown as Record<string, unknown>
    )) as NewSessionResponse;
  }

  async sessionPrompt(params: PromptRequest): Promise<PromptResponse> {
    return (await this.sendRequest(
      "session/prompt",
      params as unknown as Record<string, unknown>
    )) as PromptResponse;
  }

  async sessionSetConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    return (await this.sendRequest(
      "session/set_config_option",
      params as unknown as Record<string, unknown>
    )) as SetSessionConfigOptionResponse;
  }

  /** Cancel an ongoing prompt (fire-and-forget). */
  sessionCancel(sessionId: string): void {
    this.sendNotification("session/cancel", { sessionId });
  }

  // ─── JSON-RPC internals ────────────────────────────────────────────────────

  private sendRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("ACP client not connected"));
        return;
      }

      const id = this.nextId++;
      const req: acp.JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });

      console.error(`[ACP Client] → ${method}:`, JSON.stringify(params));
      this.proc.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    const raw: acp.JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(raw) + "\n");
  }

  private _drain(): void {
    const lines = this._stdoutBuffer.split("\n");
    this._stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as acp.AnyMessage;
        this._handleMessage(msg);
      } catch {
        this.emit("output", line);
      }
    }
  }

  private _handleMessage(msg: acp.AnyMessage): void {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;

    if (!hasId) {
      const notif = msg as acp.AnyNotification;
      console.error(`[ACP Client] ← ${notif.method}:`, JSON.stringify(notif.params));
      if (notif.method === "session/update") {
        this.emit("session/update", notif.params as unknown as SessionNotification);
      } else {
        this.emit(notif.method, notif.params);
      }
      return;
    }

    const resp = msg as acp.AnyResponse;
    console.error(`[ACP Client] ← response id=${resp.id}:`, JSON.stringify(resp.result ?? resp.error));
    const entry = this.pending.get(resp.id);
    if (!entry) return;
    this.pending.delete(resp.id);

    if ("error" in resp) {
      entry.reject(new AcpError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      entry.resolve(resp.result);
    }
  }
}
