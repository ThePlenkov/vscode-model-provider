#!/usr/bin/env node
/**
 * Mock ACP agent for testing.
 * Simulates a minimal ACP agent that:
 *   1. Responds to `initialize` with model list
 *   2. Responds to `session/new` with a sessionId
 *   3. Responds to `session/prompt` with a text response
 *
 * Usage: node mock-acp-agent.js [--models <json>] [--response <text>]
 */

"use strict";

const readline = require("readline");

const DEFAULT_MODELS = JSON.stringify([
  { id: "mock-gpt-4", name: "Mock GPT-4", description: "A mock model for testing" },
  { id: "mock-claude-3", name: "Mock Claude 3", description: "Another mock model" },
]);

let models = JSON.parse(process.env.MOCK_MODELS || DEFAULT_MODELS);
let responseText = process.env.MOCK_RESPONSE || "Hello from the mock ACP agent!";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let sessionIdCounter = 0;
const sessions = new Map();

let buffer = "";

rl.on("line", (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    // Ignore malformed lines
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    send(id, {
      protocolVersion: "1.0.0",
      agentCapabilities: { loadSession: true },
      models: models,
      instructions: "Mock ACP agent — testing only",
    });
  } else if (method === "session/new") {
    const sid = `mock-session-${++sessionIdCounter}`;
    sessions.set(sid, { cwd: params?.cwd });
    send(id, { sessionId: sid });

    // Immediately stream a session/update notification for the model
    // (some agents do this, others don't)
  } else if (method === "session/prompt") {
    const sid = params?.sessionId;
    if (!sessions.has(sid)) {
      sendError(id, -32602, "Unknown session");
      return;
    }

    // Send streaming text response as session/update notifications
    const words = responseText.split(" ");
    let wordIndex = 0;

    const streamNext = () => {
      if (wordIndex < words.length) {
        const word = words[wordIndex++] + (wordIndex < words.length ? " " : "");
        // Send as notification (no id)
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: word }],
            },
          }) + "\n"
        );
        setTimeout(streamNext, 10);
      } else {
        // Send final result
        send(id, { stopReason: "end_turn" });
      }
    };

    streamNext();
  } else if (method === "session/cancel") {
    // Acknowledge cancellation
    send(id, null);
  } else {
    // Unknown method
    sendError(id, -32601, `Method not found: ${method}`);
  }
});

function send(id, result) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
  );
}

function sendError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}
