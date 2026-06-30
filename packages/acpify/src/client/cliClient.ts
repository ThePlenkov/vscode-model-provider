/**
 * `CliAcpClient` — the VS Code extension's typed wrapper around
 * `@agentclientprotocol/sdk`'s `ClientSideConnection`.
 *
 * It is responsible for:
 *   - Spawning the CLI process over stdio.
 *   - Adapting Node `stdin`/`stdout` to the Web `Stream` the SDK consumes
 *     using the Node 18+ built-in `Readable.toWeb` / `Writable.toWeb`.
 *   - Wiring the typed reverse-call handlers (`fs.readTextFile`,
 *     `terminal.create`, `session/request_permission`, …) into the
 *     SDK's router.
 *   - Exposing the standard `session/*` calls in a flat surface that
 *     `AcpSession` (PR 02) can drive without knowing about
 *     `ClientSideConnection`.
 *
 * Per the architecture decision in `docs/architecture.md` and the
 * "Do not rewrite" constraint in the task contract, ALL NDJSON framing,
 * request/response correlation, and notification dispatch live in
 * `@agentclientprotocol/sdk`. This file is just a thin glue layer.
 *
 * The SDK's preferred API is `client({...}).connect(...)` /
 * `agent({...}).connect(...)`. We use the legacy `ClientSideConnection`
 * class because it is the simplest known-good wiring that matches the
 * structure of the public `CliClientHandlers` interface — one method
 * per reverse-call — without registering every handler via string
 * method names. The SDK retains `ClientSideConnection` as a working
 * (deprecated) API and its own in-memory round-trip tests exercise it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/* ──────────────────────── handler contract ──────────────────────── */

/**
 * Capabilities the client advertises to the agent during
 * `initialize`. Each capability here MUST have a matching reverse-call
 * handler in `CliClientHandlers`; otherwise the agent will silently
 * fail when it tries to use it.
 */
const CLIENT_CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/**
 * Reverse-call handlers. Each method is invoked by the SDK exactly
 * once per inbound request or notification. The request handlers may
 * return a `Promise`; the `onSessionUpdate` notification handler is
 * fire-and-forget.
 *
 * The optional `onElicitation` is gated behind
 * `acp.methods.client.elicitation.create`; the elicitation bridge
 * lands in PR 06.
 */
export interface CliClientHandlers {
  onSessionUpdate: (n: acp.SessionNotification) => void;
  onReadTextFile: (
    req: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse>;
  onWriteTextFile: (
    req: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse>;
  onCreateTerminal: (
    req: acp.CreateTerminalRequest,
  ) => Promise<acp.CreateTerminalResponse>;
  onTerminalOutput: (
    req: acp.TerminalOutputRequest,
  ) => Promise<acp.TerminalOutputResponse>;
  onWaitForExit: (
    req: acp.WaitForTerminalExitRequest,
  ) => Promise<acp.WaitForTerminalExitResponse>;
  onReleaseTerminal: (
    req: acp.ReleaseTerminalRequest,
  ) => Promise<acp.ReleaseTerminalResponse>;
  onRequestPermission: (
    req: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  onElicitation?: (
    req: acp.CreateElicitationRequest,
  ) => Promise<acp.CreateElicitationResponse>;
}

/**
 * Client identity used during the `initialize` handshake. The protocol
 * names this `Implementation`; the public surface calls it `clientInfo`
 * so callers don't have to know the SDK's internal type name.
 */
export interface CliClientInfo {
  name: string;
  title?: string;
  version: string;
}

/**
 * Adapts `CliClientHandlers` to the SDK's `Client` interface. We
 * build a fresh adapter per connection so handlers close over the
 * correct closures without aliasing.
 */
function toAcpClient(handlers: CliClientHandlers): acp.Client {
  const client: acp.Client = {
    sessionUpdate: (params) => {
      handlers.onSessionUpdate(params);
    },
    readTextFile: (params) => handlers.onReadTextFile(params),
    writeTextFile: (params) => handlers.onWriteTextFile(params),
    createTerminal: (params) => handlers.onCreateTerminal(params),
    terminalOutput: (params) => handlers.onTerminalOutput(params),
    waitForTerminalExit: (params) => handlers.onWaitForExit(params),
    releaseTerminal: (params) => handlers.onReleaseTerminal(params),
    requestPermission: (params) => handlers.onRequestPermission(params),
  };
  if (handlers.onElicitation) {
    client.unstable_createElicitation = (params) =>
      handlers.onElicitation!(params);
  }
  return client;
}

function clientInfoToImplementation(info: CliClientInfo): acp.Implementation {
  const out: acp.Implementation = { name: info.name, version: info.version };
  if (info.title !== undefined) out.title = info.title;
  return out;
}

/* ──────────────────────── the client ──────────────────────── */

/**
 * One process = one client. The session pool (PR 02) owns one of
 * these per `(adapter.id, cwd)` tuple.
 */
export class CliAcpClient {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private _isConnected = false;

  /**
   * Spawn the CLI, perform the JSON-RPC handshake, and resolve once
   * `initialize` has returned. The handler closures stay registered
   * for the lifetime of the process.
   */
  async connect(
    cmd: string,
    args: string[],
    handlers: CliClientHandlers,
    clientInfo: CliClientInfo,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<acp.InitializeResponse> {
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      windowsHide: true,
    });

    const { stdout, stdin, stderr } = proc;
    if (!stdout || !stdin || !stderr) {
      proc.kill();
      throw new Error("failed to open stdio pipes on the spawned CLI");
    }

    stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    const stream = acp.ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout));

    this.proc = proc;

    try {
      return await this.connectToStream(stream, handlers, clientInfo, proc);
    } catch (err) {
      proc.kill();
      this._isConnected = false;
      this.proc = null;
      throw err;
    }
  }

  /**
   * Establish an ACP client connection over an existing `Stream`.
   *
   * Exposed (not part of the public surface called out in the task
   * contract) so tests can wire an in-memory `Stream` without
   * spawning a process. The production path goes through `connect`.
   */
  async connectToStream(
    stream: acp.Stream,
    handlers: CliClientHandlers,
    clientInfo: CliClientInfo,
    proc: ChildProcess | null = null,
  ): Promise<acp.InitializeResponse> {
    this.conn = new acp.ClientSideConnection(
      () => toAcpClient(handlers),
      stream,
    );

    if (proc) {
      proc.on("close", () => {
        this._isConnected = false;
      });
      proc.on("error", (err) => {
        this._isConnected = false;
        console.error("[CliAcpClient] child error:", err);
      });
    }

    const init = await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: clientInfoToImplementation(clientInfo),
    });
    this._isConnected = true;
    return init;
  }

  /* ───────── session lifecycle (typed, schema-validated) ───────── */

  sessionNew = (p: acp.NewSessionRequest): Promise<acp.NewSessionResponse> =>
    this.assertConn().newSession(p) as Promise<acp.NewSessionResponse>;

  sessionLoad = (p: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> =>
    this.assertConn().loadSession(p) as Promise<acp.LoadSessionResponse>;

  sessionPrompt = (p: acp.PromptRequest): Promise<acp.PromptResponse> =>
    this.assertConn().prompt(p);

  sessionCancel = (p: { sessionId: string }): Promise<void> =>
    this.assertConn().cancel({ sessionId: p.sessionId });

  sessionList = (
    p: acp.ListSessionsRequest,
  ): Promise<acp.ListSessionsResponse> =>
    this.assertConn().listSessions(p) as Promise<acp.ListSessionsResponse>;

  sessionSetMode = (
    p: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> =>
    this.assertConn().setSessionMode(
      p,
    ) as Promise<acp.SetSessionModeResponse>;

  /* ───────── teardown ───────── */

  async disconnect(): Promise<void> {
    /* `ClientSideConnection` (the SDK API we wrap) does not expose
       `close()`/`signal` in this release — connection teardown is
       driven by ending the underlying stdio pipes (which kills the
       child process below) or the consumer calling
       `process.exit`. Nulling the reference and SIGTERMin the child
       is the only way to flush in this release; the SDK rejects
       pending requests with `RequestError` once stdout closes. */
    this.conn = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
      if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      this.proc = null;
    }
    this._isConnected = false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  private assertConn(): acp.ClientSideConnection {
    if (!this.conn) {
      throw new Error("CliAcpClient is not connected");
    }
    return this.conn;
  }
}
