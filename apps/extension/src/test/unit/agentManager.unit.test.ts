/**
 * Pure unit tests for AgentManager and AcpClient.
 * These run in plain Node.js — no VS Code API required.
 *
 * Run:  npx vitest run src/test/unit/agentManager.unit.test.ts
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { AgentManager } from "../../agentManager";

const FIXTURES = path.resolve(__dirname, "../../..", "test-fixtures");
const MOCK_AGENT = path.join(FIXTURES, "mock-agents", "mock-acp-agent.js");

// ─── AgentManager ──────────────────────────────────────────────────────────────

describe("AgentManager", () => {
  it("should initialize and mark agent as connected", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "mock-agent",
        label: "Mock ACP Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: true,
      },
    ]);

    expect(manager.initialized).toBe(true);
    expect(manager.agents.has("mock-agent")).toBe(true);

    const agent = manager.agents.get("mock-agent")!;
    expect(agent.connected).toBe(true);
    expect(agent.lastError).toBeUndefined();
  });

  it("should extract models from the mock agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "mock-agent",
        label: "Mock ACP Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: true,
      },
    ]);

    const models = manager.getAllModels();
    expect(models.length).toBeGreaterThan(0);

    const [entry] = models;
    expect(entry.agentId).toBe("mock-agent");
    expect(entry.model.id.length).toBeGreaterThan(0);
    expect(entry.model.name.length).toBeGreaterThan(0);
  });

  it("should skip disabled agents", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "enabled-agent",
        label: "Enabled Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: true,
      },
      {
        id: "disabled-agent",
        label: "Disabled Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: false,
      },
    ]);

    const ids = [...manager.agents.keys()];
    expect(ids).toContain("enabled-agent");
    expect(ids).not.toContain("disabled-agent");
  });

  it("should handle missing CLI gracefully", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "nonexistent",
        label: "Nonexistent",
        cliCommand: "this-cli-does-not-exist-xyz",
        enabled: true,
      },
    ]);

    const agent = manager.agents.get("nonexistent")!;
    expect(agent).toBeDefined();
    expect(agent.connected).toBe(false);
    expect(agent.lastError).toBeDefined();
  });

  it("should time out on a hanging agent process", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "timeout-agent",
        label: "Timeout Agent",
        cliCommand: "node",
        cliArgs: ["-e", "setTimeout(()=>{}, 60000)"],
        enabled: true,
      },
    ]);

    const agent = manager.agents.get("timeout-agent")!;
    expect(agent.connected).toBe(false);
    expect(agent.lastError).toMatch(/timeout/i);
  });

  it("should create a session with the mock agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "mock-agent",
        label: "Mock ACP Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: true,
      },
    ]);

    const models = manager.getAllModels();
    const modelId = `mock-agent:${models[0].model.id}`;

    const { client, sessionId } = await manager.createSession(modelId);
    expect(sessionId).toBeTruthy();
    expect(sessionId.startsWith("mock-session-")).toBe(true);
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it("createSession throws for malformed model ID", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "mock-agent",
        label: "Mock ACP Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT],
        enabled: true,
      },
    ]);

    await expect(manager.createSession("no-agent-prefix")).rejects.toThrow(/does not match/);
  });

  it("createSession throws for unknown agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([]);

    await expect(manager.createSession("unknown-agent:gpt-4")).rejects.toThrow(/unknown-agent/);
  });
});

// ─── Mock ACP Agent fixture ───────────────────────────────────────────────────

describe("Mock ACP Agent", () => {
  it("mock agent exists", () => {
    expect(fs.existsSync(MOCK_AGENT)).toBe(true);
    expect(fs.statSync(MOCK_AGENT).size).toBeGreaterThan(100);
  });

  it("responds to initialize with 2 models", async () => {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn("node", [MOCK_AGENT]);
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "1.0.0", clientCapabilities: {} },
        }) + "\n"
      );
      proc.stdin.end();

      let out = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", () => resolve(out));
      setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 3000);
    });

    const lines = output.trim().split("\n").filter(Boolean);
    const resp = JSON.parse(lines[0]);
    const models = resp.result?.models ?? [];

    expect(models.length).toBe(2);
    expect(models[0].id).toBe("mock-gpt-4");
    expect(models[1].id).toBe("mock-claude-3");
  });

  it("responds to session/new with a sessionId", async () => {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn("node", [MOCK_AGENT]);
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1.0.0", clientCapabilities: {} } }) + "\n"
      );
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } }) + "\n"
      );
      proc.stdin.end();

      let out = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", () => resolve(out));
      setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 3000);
    });

    const lines = output.trim().split("\n").filter(Boolean);
    // Second non-notification line should be session/new response
    const responses = lines.filter(l => JSON.parse(l).id != null);
    const sessionResp = JSON.parse(responses[responses.length - 1]);

    expect(sessionResp.result?.sessionId).toBeTruthy();
    expect(sessionResp.result.sessionId).toMatch(/^mock-session-\d+$/);
  });
});
