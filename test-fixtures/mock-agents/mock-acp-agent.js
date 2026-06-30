#!/usr/bin/env node
/**
 * Mock ACP v1 agent for testing.
 *
 * Simulates an ACP v1-compliant agent that:
 *   - Responds to `initialize` with v1 protocol version and capabilities
 *   - Responds to `session/new`, `session/prompt`, etc.
 *   - Sends session/update notifications with v1 discriminated union format
 *
 * Usage: node mock-acp-agent.js [--response <text>]
 */

"use strict";

const readline = require("readline");

const DEFAULT_MODELS = [
  { id: "mock-gpt-4", name: "Mock GPT-4", description: "A mock model for testing" },
  { id: "mock-claude-3", name: "Mock Claude 3", description: "Another mock model" },
];

let responseText = process.env.MOCK_RESPONSE || "Hello from the mock ACP agent v1!";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let sessionIdCounter = 0;
const sessions = new Map();

rl.on("line", (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = request;

  // ── Agent methods ──────────────────────────────────────────────────────────

  if (method === "initialize") {
    send(id, {
      protocolVersion: 1,                    // ACP v1 = integer 1
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          delete: {},
          close: {},
          resume: {},
          additionalDirectories: {},
        },
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      agentInfo: { name: "mock-acp-agent", version: "1.0.0" },
      authMethods: [{ type: "agent" }],
      // Custom extension: model list
      models: DEFAULT_MODELS,
    });

  } else if (method === "session/new") {
    const sid = `mock-session-${++sessionIdCounter}`;
    sessions.set(sid, { cwd: params?.cwd ?? process.cwd() });
    send(id, {
      sessionId: sid,
      configOptions: null,
      modes: {
        availableModes: [
          { id: "plan", name: "Plan", description: "Plan mode" },
          { id: "act", name: "Act", description: "Act mode" },
        ],
        currentModeId: "act",
      },
    });

  } else if (method === "session/prompt") {
    const sid = params?.sessionId;
    if (!sessions.has(sid)) {
      sendError(id, -32602, "Unknown session");
      return;
    }

    // Stream word-by-word using v1 session/update discriminated union
    const words = responseText.split(" ");
    let wordIndex = 0;

    const streamNext = () => {
      if (wordIndex < words.length) {
        const word = words[wordIndex++] + (wordIndex < words.length ? " " : "");
        sendNotification("session/update", {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",  // v1 discriminator
            content: [{ type: "text", text: word }],
          },
        });
        setTimeout(streamNext, 10);
      } else {
        send(id, { stopReason: "end_turn" });
      }
    };

    streamNext();

  } else if (method === "session/cancel") {
    send(id, null);

  } else if (method === "session/list") {
    send(id, {
      sessions: Array.from(sessions.entries()).map(([sid, s]) => ({
        sessionId: sid,
        cwd: s.cwd,
        title: null,
        updatedAt: null,
      })),
      nextCursor: null,
    });

  } else if (method === "session/delete") {
    sessions.delete(params?.sessionId);
    send(id, null);

  } else if (method === "session/close") {
    sessions.delete(params?.sessionId);
    send(id, null);

  } else if (method === "session/resume") {
    send(id, { configOptions: null, modes: null });

  } else if (method === "session/load") {
    send(id, {
      sessionId: params?.sessionId ?? "loaded-session",
      configOptions: null,
      modes: null,
    });

  } else if (method === "session/set_mode") {
    send(id, null);

  } else if (method === "session/set_config_option") {
    send(id, { configOptions: [] });

  } else if (method === "authenticate") {
    send(id, null);

  } else if (method === "logout") {
    send(id, null);

  // ── Client → Agent methods (not implemented in mock, but acknowledged) ─────
  } else if (method === "session/request_permission") {
    sendError(id, -32601, "Permission handling not implemented in mock");

  } else if (method === "terminal/create") {
    sendError(id, -32601, "Terminal not implemented in mock");

  } else if (method === "terminal/output") {
    sendError(id, -32601, "Terminal not implemented in mock");

  } else if (method === "terminal/kill") {
    sendError(id, -32601, "Terminal not implemented in mock");

  } else if (method === "terminal/wait_for_exit") {
    sendError(id, -32601, "Terminal not implemented in mock");

  } else if (method === "terminal/release") {
    sendError(id, -32601, "Terminal not implemented in mock");

  } else if (method === "fs/read_text_file") {
    sendError(id, -32601, "fs/read_text_file not implemented in mock");

  } else if (method === "fs/write_text_file") {
    sendError(id, -32601, "fs/write_text_file not implemented in mock");

  } else {
    sendError(id, -32601, `Method not found: ${method}`);
  }
});

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function sendNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
