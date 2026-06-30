/**
 * Tier-1+2 tests for `CliAcpClient`.
 *
 * Covers the three behaviours the task contract requires:
 *   1. NDJSON framing at the `CliAcpClient` level — a `session/update`
 *      written as a partial JSON envelope must NOT arrive at
 *      `onSessionUpdate` until the rest of the bytes flush through the
 *      agent-side writable. The test exercises `CliAcpClient` end-to-end
 *      rather than the SDK's `ndJsonStream` parser in isolation.
 *   2. Reverse-call dispatch — `session/update` notification arrives on
 *      `onSessionUpdate`.
 *   3. Reverse-call round-trip — `fs/read_text_file` is dispatched to
 *      `onReadTextFile` and the response is framed back to the agent.
 *
 * The tests build an in-memory Stream pair (no subprocess) by wiring
 * Node `PassThrough`s into web `ReadableStream`/`WritableStream` via
 * `Writable.toWeb` / `Readable.toWeb`. The SDK's `ndJsonStream` then
 * frames both sides — the same pattern as the SDK's own Tier-2 tests
 * in `node_modules/@agentclientprotocol/sdk/dist/acp.test.js`.
 *
 * `ClientSideConnection` and `AgentSideConnection` are marked
 * `@deprecated` in favour of the `client({...}).connect(...)` /
 * `agent({...}).connect(...)` builders, but they remain the simplest
 * known-good API for two-process in-memory round-trips. We pair the
 * deprecated `AgentSideConnection` here purely on the test (fake-agent)
 * side so we don't have to re-register every handler via method-name
 * strings — the wiring under test is `CliAcpClient`, not the agent.
 */

import { PassThrough, Transform } from "node:stream";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { CliAcpClient } from "./cliClient.js";
import type { CliClientHandlers, CliClientInfo } from "./cliClient.js";

/* ─────────────── Stream pair helper ─────────────── */

function memoryStreamPair(): {
  agentToClient: PassThrough;
  clientToAgent: PassThrough;
  agentStream: Stream;
  clientStream: Stream;
} {
  const agentToClient = new PassThrough();
  const clientToAgent = new PassThrough();
  const agentStream = ndJsonStream(
    Writable.toWeb(clientToAgent),
    Readable.toWeb(agentToClient),
  );
  const clientStream = ndJsonStream(
    Writable.toWeb(agentToClient),
    Readable.toWeb(clientToAgent),
  );
  return { agentToClient, clientToAgent, agentStream, clientStream };
}

/**
 * `SplitTransform` — a `Transform` that forwards bytes synchronously
 * in normal use, but exposes `splitForward(chunk)` which deliberately
 * delivers `chunk` as two halves with one macrotask between them.
 *
 * The test uses this to *insert* a partial-frame boundary at the
 * Writable.toWeb / Readable.toWeb adapter pair that the
 * `CliAcpClient` and the agent exchange bytes through. Once split,
 * the CliAcpClient's parser must buffer the first half until the
 * second arrives.
 */
class SplitTransform extends Transform {
  constructor() {
    super({});
  }
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.push(chunk);
    cb();
  }
  splitForward(chunk: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const mid = Math.floor(chunk.length / 2);
      this.push(chunk.subarray(0, mid));
      setImmediate(() => {
        this.push(chunk.subarray(mid));
        resolve();
      });
    });
  }
}

/* ─────────────── Stubs ─────────────── */

function stubHandlers(
  overrides: Partial<CliClientHandlers> = {},
): CliClientHandlers {
  return {
    onSessionUpdate: vi.fn(),
    onReadTextFile: vi.fn(
      async () => ({ content: "" }) as Awaited<ReturnType<CliClientHandlers["onReadTextFile"]>>,
    ),
    onWriteTextFile: vi.fn(
      async () => ({}) as Awaited<ReturnType<CliClientHandlers["onWriteTextFile"]>>,
    ),
    onCreateTerminal: vi.fn(
      async () =>
        ({ terminalId: "term-stub" }) as Awaited<
          ReturnType<CliClientHandlers["onCreateTerminal"]>
        >,
    ),
    onTerminalOutput: vi.fn(
      async () =>
        ({
          terminalId: "term-stub",
          output: "",
          truncated: false,
        }) as unknown as Awaited<
          ReturnType<CliClientHandlers["onTerminalOutput"]>
        >,
    ),
    onWaitForExit: vi.fn(
      async () =>
        ({
          terminalId: "term-stub",
          exitCode: 0,
        }) as unknown as Awaited<ReturnType<CliClientHandlers["onWaitForExit"]>>,
    ),
    onReleaseTerminal: vi.fn(
      async () => ({}) as Awaited<ReturnType<CliClientHandlers["onReleaseTerminal"]>>,
    ),
    onRequestPermission: vi.fn(
      async () =>
        ({
          outcome: { outcome: "cancelled" },
        }) as unknown as Awaited<
          ReturnType<CliClientHandlers["onRequestPermission"]>
        >,
    ),
    ...overrides,
  };
}

const clientInfo: CliClientInfo = {
  name: "vscode-model-provider-test",
  title: "vscode-model-provider (test)",
  version: "0.0.0-test",
};

function minimalAgent(): Agent {
  return {
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
    }),
    newSession: async () => ({ sessionId: "sess-default" }),
  } as unknown as Agent;
}

/* ─────────────────────── Test 1: NDJSON framing ───────────────────── */

describe("CliAcpClient — NDJSON framing via the spawned stdio stream pair", () => {
  it("buffers partial frames and only delivers the message once the rest of the bytes arrive", async () => {
    /* The SDK does all NDJSON framing inside `ndJsonStream`. From the
       client's point of view, that means: bytes written to the
       Writable side are framed, sent to the agent; bytes received
       from the agent are unframed on the Readable side and dispatched
       to handlers. This test exercises that contract at the
       CliAcpClient level rather than driving the parser in
       isolation.

       Topology for this test:

         Writable.toWeb(splitter)  <──  AgentSideConnection (output)
         splitter  ──►  client.ndJsonStream.input
         client.ndJsonStream.output  ──►  Writable.toWeb(clientToAgent)
                                                       │
                                                       └─►  AgentSideConnection (input)

       The `splitter` is a Transform that sits at the same
       Writable.toWeb / Readable.toWeb boundary the SDK uses against
       a real CLI process. Its default `_transform` forwards bytes
       synchronously. `splitForward` is the test's only timing
       primitive: it pushes the first half immediately and the second
       half after exactly one macrotask.

       Steps:
         1. Drive a complete framed notification through the
            splitter (default pass-through) and assert it arrives at
            `onSessionUpdate`. This proves the Writable.toWeb /
            Readable.toWeb → ndJsonStream → handler pipeline works
            through the splice.
         2. Drive a SECOND notification through `splitForward`,
            which delivers it as two halves separated by one
            macrotask. We assert that:
              – Right after the first half is forwarded and any
                synchronous microtasks have run, the handler count
                has NOT increased (partial frame is still buffered
                inside the SDK parser).
              – After both halves are forwarded, the handler count
                has increased by exactly one and the second
                notification's payload matches what we sent. */

    const splitter = new SplitTransform();
    const clientToAgent = new PassThrough();

    const agentStream = ndJsonStream(
      Writable.toWeb(splitter),
      Readable.toWeb(clientToAgent),
    );
    const clientStream = ndJsonStream(
      Writable.toWeb(clientToAgent),
      Readable.toWeb(splitter as unknown as Readable),
    );

    const agent = new AgentSideConnection(
      () => minimalAgent(),
      agentStream,
    );

    const handlers = stubHandlers({ onSessionUpdate: vi.fn() });
    const client = new CliAcpClient();
    const init = await client.connectToStream(
      clientStream,
      handlers,
      clientInfo,
    );
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    /* 1) Drive a complete notification through the splitter's
       default pass-through path. This exercises the full
       Writable.toWeb / Readable.toWeb → ndJsonStream → handler
       pipeline at the CliAcpClient level. */
    const note1: SessionNotification = {
      sessionId: "sess-partial",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
      },
    };
    const frame1 = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: note1,
      }) + "\n",
      "utf-8",
    );
    splitter.write(frame1);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      if (
        (handlers.onSessionUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length === 1
      )
        break;
    }
    expect(handlers.onSessionUpdate).toHaveBeenCalledTimes(1);
    const first = (handlers.onSessionUpdate as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as SessionNotification;
    expect(
      (first.update as Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }>)
        .content,
    ).toEqual({ type: "text", text: "first" });

    /* 2) Drive a SECOND notification through `splitForward`. The
       contract is that the parser buffers the first half (it's an
       incomplete JSON-RPC envelope) and only surfaces the message
       after both halves land. */
    const note2: SessionNotification = {
      sessionId: "sess-partial",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      },
    };
    const frame2 = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: note2,
      }) + "\n",
      "utf-8",
    );

    const splitDone = splitter.splitForward(frame2);
    /* Yield only to the microtask queue — we want to observe the
       half-frame buffered state before the splitter's `setImmediate`
       fires the second half. */
    await Promise.resolve();
    expect(handlers.onSessionUpdate).toHaveBeenCalledTimes(1);

    /* Now let the splitter's `setImmediate` run and the parser drain
       the second half. */
    await splitDone;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      if (
        (handlers.onSessionUpdate as ReturnType<typeof vi.fn>).mock.calls
          .length === 2
      )
        break;
    }
    expect(handlers.onSessionUpdate).toHaveBeenCalledTimes(2);
    const second = (handlers.onSessionUpdate as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as SessionNotification;
    expect(
      (second.update as Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }>)
        .content,
    ).toEqual({ type: "text", text: "partial" });

    /* Reference the agent connection so the linter doesn't flag it
       as unused — we needed it solely to satisfy the initialize
       handshake. */
    void agent;

    await client.disconnect();
  });
});

/* ─────────────── Test 2: Reverse-call dispatch (session/update) ─────────── */

describe("CliAcpClient — reverse-call dispatch", () => {
  it("delivers a session/update notification to onSessionUpdate", async () => {
    const { agentToClient, clientToAgent, clientStream } = memoryStreamPair();
    const handlers = stubHandlers({ onSessionUpdate: vi.fn() });

    /* The agent side must be live BEFORE the client sends
       `initialize`, otherwise the request hangs. */
    const agentConn = new AgentSideConnection(
      () => minimalAgent(),
      ndJsonStream(
        Writable.toWeb(clientToAgent),
        Readable.toWeb(agentToClient),
      ),
    );

    const client = new CliAcpClient();
    const init = await client.connectToStream(
      clientStream,
      handlers,
      clientInfo,
    );
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

    const note: SessionNotification = {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from agent" },
      },
    };
    await agentConn.sessionUpdate(note);
    await new Promise((r) => setTimeout(r, 30));

    expect(handlers.onSessionUpdate).toHaveBeenCalledTimes(1);
    const received = (handlers.onSessionUpdate as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as SessionNotification;
    expect(received.sessionId).toBe("sess-1");
    expect(received.update.sessionUpdate).toBe("agent_message_chunk");

    await client.disconnect();
  });
});

/* ────────── Test 3: Reverse-call round-trip (fs/read_text_file) ─────────── */

describe("CliAcpClient — reverse-call round-trip", () => {
  it("responds to fs/read_text_file requests from the agent", async () => {
    const { agentToClient, clientToAgent, clientStream } = memoryStreamPair();
    const handlers = stubHandlers({
      onReadTextFile: vi.fn(async (req: ReadTextFileRequest) => ({
        content: `contents-of:${req.path}`,
      })),
    });

    const agentConn = new AgentSideConnection(
      () => minimalAgent(),
      ndJsonStream(
        Writable.toWeb(clientToAgent),
        Readable.toWeb(agentToClient),
      ),
    );

    const client = new CliAcpClient();
    await client.connectToStream(clientStream, handlers, clientInfo);

    const req: ReadTextFileRequest = {
      sessionId: "sess-2",
      path: "/tmp/example.txt",
    };
    const responded: ReadTextFileResponse = await agentConn.readTextFile(req);
    expect(responded).toEqual({ content: "contents-of:/tmp/example.txt" });
    expect(handlers.onReadTextFile).toHaveBeenCalledTimes(1);
    const called = (handlers.onReadTextFile as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReadTextFileRequest;
    expect(called.path).toBe("/tmp/example.txt");

    await client.disconnect();
  });
});
