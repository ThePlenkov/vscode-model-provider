import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  AcpModelInfo,
  AcpProtocolVersion,
  AcpClientCapabilities,
  AcpClientInfo,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpAgentCapabilities,
  AcpAuthenticateParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionListParams,
  AcpSessionListResult,
  AcpSessionResumeParams,
  AcpSessionResumeResult,
  AcpSessionLoadParams,
  AcpSessionDeleteParams,
  AcpSessionDeleteResult,
  AcpSessionCloseParams,
  AcpSessionCloseResult,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionSetModeParams,
  AcpSessionSetModeResult,
  AcpSessionSetConfigOptionParams,
  AcpSessionSetConfigOptionResult,
  AcpLogoutResult,
  AcpSessionNotification,
  AcpSessionRequestPermissionParams,
  AcpSessionRequestPermissionResult,
  AcpTerminalOutputParams,
  AcpTerminalOutputResult,
  AcpFsReadTextFileParams,
  AcpFsReadTextFileResult,
  AcpFsWriteTextFileParams,
  AcpFsWriteTextFileResult,
  AcpTerminalCreateParams,
  AcpTerminalCreateResult,
  AcpTerminalKillParams,
  AcpTerminalKillResult,
  AcpTerminalWaitForExitParams,
  AcpTerminalWaitForExitResult,
  AcpTerminalReleaseParams,
  AcpTerminalReleaseResult,
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
  private _protocolVersion: AcpProtocolVersion = 0;
  private _agentCapabilities: AcpAgentCapabilities = {};

  /**
   * Models advertised by the agent during `initialize`.
   * This is a custom extension not in the ACP v1 core spec — some agents
   * (e.g. Claude Code) include a `models` array in the init response.
   */
  private _discoveredModels: AcpModelInfo[] = [];

  get discoveredModels(): AcpModelInfo[] {
    return this._discoveredModels;
  }

  get protocolVersion(): AcpProtocolVersion {
    return this._protocolVersion;
  }

  get agentCapabilities(): AcpAgentCapabilities {
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
    clientInfo?: AcpClientInfo,
    clientCapabilities?: AcpClientCapabilities
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

      const params: AcpInitializeParams = {
        // ACP v1 = integer 1
        protocolVersion: 1,
        clientCapabilities: clientCapabilities ?? { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo,
      };

      this.sendRequest("initialize", params as unknown as Record<string, unknown>)
        .then((result) => {
          const r = result as AcpInitializeResult & { models?: AcpModelInfo[] };
          this._protocolVersion = r.protocolVersion;
          this._agentCapabilities = r.agentCapabilities ?? {};
          // Custom extension: some agents include model list in init response
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

  // ─── Authentication ─────────────────────────────────────────────────────────

  async authenticate(params: AcpAuthenticateParams = {}): Promise<void> {
    await this.sendRequest("authenticate", params as unknown as Record<string, unknown>);
  }

  async logout(): Promise<AcpLogoutResult> {
    return (await this.sendRequest("logout", {})) as AcpLogoutResult;
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────

  async sessionNew(params: AcpSessionNewParams): Promise<AcpSessionNewResult> {
    return (await this.sendRequest(
      "session/new",
      params as unknown as Record<string, unknown>
    )) as AcpSessionNewResult;
  }

  async sessionList(params?: AcpSessionListParams): Promise<AcpSessionListResult> {
    return (await this.sendRequest(
      "session/list",
      (params ?? {}) as unknown as Record<string, unknown>
    )) as AcpSessionListResult;
  }

  async sessionResume(params: AcpSessionResumeParams): Promise<AcpSessionResumeResult> {
    return (await this.sendRequest(
      "session/resume",
      params as unknown as Record<string, unknown>
    )) as AcpSessionResumeResult;
  }

  async sessionLoad(params: AcpSessionLoadParams): Promise<AcpSessionNewResult> {
    return (await this.sendRequest(
      "session/load",
      params as unknown as Record<string, unknown>
    )) as AcpSessionNewResult;
  }

  async sessionDelete(params: AcpSessionDeleteParams): Promise<AcpSessionDeleteResult> {
    return (await this.sendRequest(
      "session/delete",
      params as unknown as Record<string, unknown>
    )) as AcpSessionDeleteResult;
  }

  async sessionClose(params: AcpSessionCloseParams): Promise<AcpSessionCloseResult> {
    return (await this.sendRequest(
      "session/close",
      params as unknown as Record<string, unknown>
    )) as AcpSessionCloseResult;
  }

  // ─── Prompt ────────────────────────────────────────────────────────────────

  async sessionPrompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    return (await this.sendRequest(
      "session/prompt",
      params as unknown as Record<string, unknown>
    )) as AcpPromptResult;
  }

  async sessionSetMode(params: AcpSessionSetModeParams): Promise<AcpSessionSetModeResult> {
    return (await this.sendRequest(
      "session/set_mode",
      params as unknown as Record<string, unknown>
    )) as AcpSessionSetModeResult;
  }

  async sessionSetConfigOption(
    params: AcpSessionSetConfigOptionParams
  ): Promise<AcpSessionSetConfigOptionResult> {
    return (await this.sendRequest(
      "session/set_config_option",
      params as unknown as Record<string, unknown>
    )) as AcpSessionSetConfigOptionResult;
  }

  /** Cancel an ongoing prompt (fire-and-forget). */
  sessionCancel(sessionId: string): void {
    this.sendNotification("session/cancel", { sessionId });
  }

  // ─── Client → Agent: permission request ────────────────────────────────────

  async sessionRequestPermission(
    params: AcpSessionRequestPermissionParams
  ): Promise<AcpSessionRequestPermissionResult> {
    return (await this.sendRequest(
      "session/request_permission",
      params as unknown as Record<string, unknown>
    )) as AcpSessionRequestPermissionResult;
  }

  // ─── Client → Agent: terminal ─────────────────────────────────────────────

  async terminalCreate(params: AcpTerminalCreateParams): Promise<AcpTerminalCreateResult> {
    return (await this.sendRequest(
      "terminal/create",
      params as unknown as Record<string, unknown>
    )) as AcpTerminalCreateResult;
  }

  async terminalOutput(params: AcpTerminalOutputParams): Promise<AcpTerminalOutputResult> {
    return (await this.sendRequest(
      "terminal/output",
      params as unknown as Record<string, unknown>
    )) as AcpTerminalOutputResult;
  }

  async terminalWaitForExit(
    params: AcpTerminalWaitForExitParams
  ): Promise<AcpTerminalWaitForExitResult> {
    return (await this.sendRequest(
      "terminal/wait_for_exit",
      params as unknown as Record<string, unknown>
    )) as AcpTerminalWaitForExitResult;
  }

  async terminalKill(params: AcpTerminalKillParams): Promise<AcpTerminalKillResult> {
    return (await this.sendRequest(
      "terminal/kill",
      params as unknown as Record<string, unknown>
    )) as AcpTerminalKillResult;
  }

  async terminalRelease(params: AcpTerminalReleaseParams): Promise<AcpTerminalReleaseResult> {
    return (await this.sendRequest(
      "terminal/release",
      params as unknown as Record<string, unknown>
    )) as AcpTerminalReleaseResult;
  }

  // ─── Client → Agent: fs ───────────────────────────────────────────────────

  async fsReadTextFile(params: AcpFsReadTextFileParams): Promise<AcpFsReadTextFileResult> {
    return (await this.sendRequest(
      "fs/read_text_file",
      params as unknown as Record<string, unknown>
    )) as AcpFsReadTextFileResult;
  }

  async fsWriteTextFile(params: AcpFsWriteTextFileParams): Promise<AcpFsWriteTextFileResult> {
    return (await this.sendRequest(
      "fs/write_text_file",
      params as unknown as Record<string, unknown>
    )) as AcpFsWriteTextFileResult;
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

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    const raw: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(raw) + "\n");
  }

  private _drain(): void {
    const lines = this._stdoutBuffer.split("\n");
    this._stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        this._handleMessage(msg);
      } catch {
        this.emit("output", line);
      }
    }
  }

  private _handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;

    if (!hasId) {
      const notif = msg as JsonRpcNotification;
      if (notif.method === "session/update") {
        this.emit("session/update", notif.params as unknown as AcpSessionNotification);
      } else {
        this.emit(notif.method, notif.params);
      }
      return;
    }

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
