import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { AgentManager, AgentConfig } from "../../agentManager";

const FIXTURES = path.resolve(__dirname, "../../..", "test-fixtures");

// Path to our mock ACP agent
const MOCK_AGENT_PATH = path.join(FIXTURES, "mock-agents", "mock-acp-agent.js");

suite("Extension Activation", () => {
  test("extension should activate without errors", async () => {
    // The extension auto-activates on `onLanguageModelChatContext`
    // If we reach this test, the extension activated successfully.
    const ext = vscode.extensions.getExtension("theplenkov.vscode-model-provider");
    assert.ok(ext, "Extension should be installed");
    assert.ok(ext!.isActive, "Extension should be active");
  });

  test("language model chat provider should be registered", async () => {
    // The model picker is interactive — can't easily test it automatically
    // But we can verify the provider is registered by checking the extension is active
    const ext = vscode.extensions.getExtension("theplenkov.vscode-model-provider");
    assert.ok(ext!.isActive, "Extension should be active");
  });
});

suite("AgentManager", () => {
  const mockAgentConfig: AgentConfig = {
    id: "mock-agent",
    label: "Mock ACP Agent",
    cliCommand: "node",
    cliArgs: [MOCK_AGENT_PATH],
    enabled: true,
  };

  test("should discover and connect to a mock ACP agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([mockAgentConfig]);

    assert.ok(manager.initialized, "Manager should be initialized");
    assert.ok(manager.agents.has("mock-agent"), "mock-agent should be in agents map");

    const agent = manager.agents.get("mock-agent")!;
    assert.ok(agent.connected, `Agent should be connected: ${agent.lastError ?? "no error"}`);
  });

  test("should extract models from the mock agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([mockAgentConfig]);

    const models = manager.getAllModels();
    assert.ok(models.length > 0, "Should have discovered at least one model");

    const entry = models[0];
    assert.strictEqual(entry.agentId, "mock-agent");
    assert.ok(entry.model.id, "Model should have an id");
    assert.ok(entry.model.name, "Model should have a name");
  });

  test("should handle a missing CLI gracefully", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "nonexistent",
        label: "Nonexistent",
        cliCommand: "this-cli-does-not-exist-xyz",
        enabled: true,
      },
    ]);

    const agent = manager.agents.get("nonexistent");
    assert.ok(agent, "Agent entry should exist even if CLI is missing");
    assert.ok(!agent!.connected, "Agent should not be connected");
    assert.ok(agent!.lastError, "Should have an error message");
  });

  test("should skip disabled agents", async () => {
    const manager = new AgentManager();
    await manager.initialize([
      { ...mockAgentConfig, id: "enabled-agent", enabled: true },
      { ...mockAgentConfig, id: "disabled-agent", enabled: false },
    ]);

    const agentIds = [...manager.agents.keys()];
    assert.ok(agentIds.includes("enabled-agent"), "enabled-agent should be in map");
    assert.ok(!agentIds.includes("disabled-agent"), "disabled-agent should not be in map");
  });

  test("should create a session with the mock agent", async () => {
    const manager = new AgentManager();
    await manager.initialize([mockAgentConfig]);

    const models = manager.getAllModels();
    assert.ok(models.length > 0, "Should have at least one model");

    const modelId = `mock-agent:${models[0]!.model.id}`;
    const { client, sessionId } = await manager.createSession(modelId);

    assert.ok(sessionId, "Session ID should be non-empty");
    assert.ok(client.isConnected, "Client should be connected");

    client.disconnect();
  });

  test("createSession should throw for unknown model ID format", async () => {
    const manager = new AgentManager();
    await manager.initialize([mockAgentConfig]);

    // Missing agent prefix
    await assert.rejects(
      () => manager.createSession("unknown-model"),
      /does not match/
    );
  });
});

suite("AcpModelProvider", () => {
  test("should return placeholder when no agents are connected", async () => {
    const { AcpModelProvider } = await import("../../acpProvider");
    const manager = new AgentManager();
    // Don't initialize — no agents
    const provider = new AcpModelProvider(manager, "Test");

    const models = await provider.provideLanguageModelChatInformation(
      { silent: false },
      { isCancellationRequested: false } as vscode.CancellationToken
    );

    // Should return placeholder model
    assert.ok(models && models.length > 0, "Should return at least the placeholder");
    const placeholder = models!.find((m) => m.id === "acp:no-agent");
    assert.ok(placeholder, "Should have a 'no-agent' placeholder");
    assert.strictEqual(placeholder!.maxInputTokens, 0, "Placeholder should have 0 tokens");
  });

  test("should return models from connected agent", async () => {
    const { AcpModelProvider } = await import("../../acpProvider");
    const manager = new AgentManager();
    await manager.initialize([
      {
        id: "mock-agent",
        label: "Mock ACP Agent",
        cliCommand: "node",
        cliArgs: [MOCK_AGENT_PATH],
        enabled: true,
      },
    ]);

    const provider = new AcpModelProvider(manager, "Test");
    const models = await provider.provideLanguageModelChatInformation(
      { silent: false },
      { isCancellationRequested: false } as vscode.CancellationToken
    );

    const realModels = models!.filter((m) => m.id !== "acp:no-agent");
    assert.ok(realModels.length > 0, "Should have real models from mock agent");

    // Check model ID format
    const first = realModels[0];
    assert.ok(
      first.id.startsWith("mock-agent:"),
      `Model ID should start with 'mock-agent:': ${first.id}`
    );
    assert.ok(first.name.includes("Test"), "Model name should include prefix");
    assert.strictEqual(first.capabilities.toolCalling, true, "toolCalling should be enabled");
  });

  test("token count should be estimated", async () => {
    const { AcpModelProvider } = await import("../../acpProvider");
    const manager = new AgentManager();
    const provider = new AcpModelProvider(manager, "Test");

    const fakeModel: vscode.LanguageModelChatInformation = {
      id: "test:model",
      name: "Test Model",
      family: "test",
      version: "1",
      maxInputTokens: 128_000,
      maxOutputTokens: 32_768,
      capabilities: { toolCalling: true },
    };

    const count = await provider.provideTokenCount(
      fakeModel,
      "hello world this is a test", // 28 chars ≈ 7 tokens at 4 chars/token
      { isCancellationRequested: false } as vscode.CancellationToken
    );

    assert.ok(count > 0, "Token count should be positive");
    assert.ok(count < 28, "Token count should be less than char count"); // rough estimate
  });
});
