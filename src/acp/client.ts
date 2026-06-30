import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  ACP_PROTOCOL_VERSION,
  AcpAgentCapability,
  AcpClientCapability,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpModelInfo,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionSetModeParams,
  AcpSessionUpdateParams,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types";

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
 * ACP JSON-RPC 2.0 client over stdio.
 *
 * Usage:
 * ```ts
 * const client = new AcpClient();
 * await client.connect('claude', ['--acp']);
 * const models = client.discoveredModels; // populated after init
 * const { sessionId } = await client.sessionNew();
 * // ... stream updates via client.on('session/update', ...)
 * await client.sessionPrompt(sessionId, [{ type: 'text', text: 'hi' }]);
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

  /** Populated by `connect()` after the `initialize` round-trip. */
  private _agentCapabilities: AcpAgentCapability = {};
  private _instructions: string | undefined;
  private _models: AcpModelInfo[] = [];

  get agentCapabilities(): AcpAgentCapability {
    return this._agentCapabilities;
  }

  get instructions(): string | undefined {
    return this._instructions;
  }

  get discoveredModels(): AcpModelInfo[] {
    return this._models;
  }

  get isConnected(): boolean {
    return this.proc !== null && !this._disconnected;
  }

  /**
   * Spawn the agent process and run the `initialize` handshake.
   * Does NOT authenticate — call `authenticate()` separately if needed.
   */
  connect(cliCommand: string, cliArgs: string[] = ["--acp"]): Promise<void> {
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
        // Agent diagnostic output — forward to caller
        this.emit("stderr", chunk.toString());
      });

      this.proc.stdout.on("data", (chunk: Buffer) => {
        this._stdoutBuffer += chunk.toString();
        this._drain();
      });

      // ── ACP initialization ────────────────────────────────────────────────
      const initParams: AcpInitializeParams = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      };

      this.sendRequest("initialize", initParams as unknown as Record<string, unknown>)
        .then((result) => {
          const r = result as AcpInitializeResult;
          this._agentCapabilities = r.agentCapabilities ?? {};
          this._instructions = r.instructions;
          // Extract models from init response if the agent advertises them
          if (r.models && Array.isArray(r.models)) {
            this._models = r.models;
          }
          this.emit("ready");
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Run the `authenticate` round-trip. Call after `connect()` if the agent
   * requires it (e.g. when `agentCapabilities.auth` is present).
   */
  async authenticate(params: Record<string, unknown> = {}): Promise<void> {
    await this.sendRequest("authenticate", params);
  }

  async sessionNew(params: AcpSessionNewParams = {}): Promise<AcpSessionNewResult> {
    return (await this.sendRequest(
      "session/new",
      params as unknown as Record<string, unknown>
    )) as AcpSessionNewResult;
  }

  async sessionPrompt(
    params: AcpSessionPromptParams
  ): Promise<AcpSessionPromptResult> {
    return (await this.sendRequest(
      "session/prompt",
      params as unknown as Record<string, unknown>
    )) as AcpSessionPromptResult;
  }

  async sessionSetMode(params: AcpSessionSetModeParams): Promise<void> {
    await this.sendRequest(
      "session/set_mode",
      params as unknown as Record<string, unknown>
    );
  }

  async sessionLoad(params: {
    sessionId: string;
  }): Promise<AcpSessionNewResult> {
    return (await this.sendRequest(
      "session/load",
      params as unknown as Record<string, unknown>
    )) as AcpSessionNewResult;
  }

  /** Cancel an ongoing prompt (fire-and-forget notification). */
  sessionCancel(sessionId: string): void {
    this.sendNotification("session/cancel", { sessionId });
  }

  /** Terminate the agent process gracefully. */
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

  // ─── Private JSON-RPC machinery ────────────────────────────────────────────

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
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });

      this.proc.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): void {
    if (!this.proc?.stdin) return;
    const raw: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(raw) + "\n");
  }

  /** Drain newline-delimited JSON-RPC messages from the stdout buffer. */
  private _drain(): void {
    const lines = this._stdoutBuffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    this._stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        this._handleMessage(msg);
      } catch {
        // Not JSON — treat as stderr-like output
        this.emit("output", line);
      }
    }
  }

  private _handleMessage(
    msg: JsonRpcResponse | JsonRpcNotification
  ): void {
    // Check if this is a notification (id is null or missing)
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;

    if (!hasId) {
      const notif = msg as JsonRpcNotification;
      if (notif.method === "session/update") {
        this.emit("session/update", notif.params as unknown as AcpSessionUpdateParams);
      } else {
        this.emit(notif.method, notif.params);
      }
      return;
    }

    // It's a response
    const resp = msg as JsonRpcResponse;
    const entry = this.pending.get(resp.id);
    if (!entry) return;
    this.pending.delete(resp.id);

    if (resp.error) {
      entry.reject(new AcpError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      entry.resolve(resp.result);
    }
  }
}
