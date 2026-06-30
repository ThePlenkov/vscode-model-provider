import * as vscode from "vscode";
import { AgentManager, AgentConfig } from "./agentManager";
import { AcpModelProvider, toLmModel } from "./acpProvider";
import { AgentManagerUI } from "./agentManagerUI";
import { AgentTreeDataProvider, AgentTreeItem } from "./agentTreeView";
import type { ModelInfo } from "./acp";

const CONFIG_NS = "acpModelProvider";

let agentManager: AgentManager;
let provider: AcpModelProvider;
let outputChannel: vscode.OutputChannel;
let agentUI: AgentManagerUI;
let treeDataProvider: AgentTreeDataProvider;

export async function activate(ctx: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("ACP Model Provider");
  outputChannel.appendLine("[ACP Model Provider] Activating...");
  outputChannel.appendLine("[ACP Model Provider] Extension ID: " + ctx.extension.id);

  // ── Read configuration ────────────────────────────────────────────────────
  const configuredAgents = vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<AgentConfig[]>("agents", []);

  const displayPrefix =
    vscode.workspace
      .getConfiguration(CONFIG_NS)
      .get<string>("modelDisplayPrefix", "ACP") ?? "ACP";

  if (configuredAgents.length === 0) {
    vscode.window.showWarningMessage(
      "[ACP Model Provider] No agents configured. " +
        "Add ACP agents in Settings → ACP Model Provider → Agents."
    );
  }

  // ── Initialize agent discovery ────────────────────────────────────────────
  agentManager = new AgentManager();

  (agentManager as any).on("disconnect", (err: any) => {
    outputChannel.appendLine(`[disconnect] ${err}`);
  });

  outputChannel.appendLine(
    `[init] Discovering ${configuredAgents.length} configured agents...`
  );

  await agentManager.initialize(configuredAgents);

  // ── Log discovery results ───────────────────────────────────────────────────
  const connected = [...agentManager.agents.values()].filter((a) => a.connected);
  const failed = [...agentManager.agents.values()].filter((a) => !a.connected);

  for (const a of connected) {
    const modelCount = a.models.length;
    outputChannel.appendLine(
      `  ✓ ${a.config.label} (${a.config.id}): ${modelCount} model(s)`
    );
    for (const m of a.models) {
      outputChannel.appendLine(`      • ${m.id}${m.description ? ` — ${m.description}` : ""}`);
    }
  }

  for (const a of failed) {
    outputChannel.appendLine(
      `  ✗ ${a.config.label} (${a.config.id}): ${a.lastError ?? "unknown error"}`
    );
  }

  if (connected.length === 0) {
    vscode.window.showWarningMessage(
      "[ACP Model Provider] No ACP agents could be connected. " +
        "Make sure at least one ACP-compatible agent (Claude Code, Gemini CLI, Codex, etc.) " +
        "is installed and its CLI is on PATH."
    );
  }

  // ── Register the LanguageModelChatProvider ─────────────────────────────────
  provider = new AcpModelProvider(agentManager, displayPrefix);
  const registration = vscode.lm.registerLanguageModelChatProvider(
    "acp",
    provider
  );

  // Fire the event to notify VS Code that models are available
  const models = agentManager.getAllModels();
  if (models.length > 0) {
    (provider as any)._onDidChangeLanguageModelChatInformation.fire(
      models.map(({ agentId, model }) =>
        toLmModel(agentId, agentManager.agents.get(agentId)!.config.label, model, displayPrefix)
      )
    );
  }

  // ── Initialize UI ───────────────────────────────────────────────────────────
  agentUI = new AgentManagerUI(agentManager);

  // ── Register Tree View ─────────────────────────────────────────────────────
  treeDataProvider = new AgentTreeDataProvider(agentManager);
  const treeViewRegistration = vscode.window.registerTreeDataProvider('acpModelProvider.agentsView', treeDataProvider);
  ctx.subscriptions.push(treeViewRegistration);

  outputChannel.appendLine("[ACP Model Provider] Tree view registered.");
  
  // Trigger initial refresh after agent manager is initialized
  setTimeout(() => {
    treeDataProvider.refresh();
    outputChannel.appendLine("[ACP Model Provider] Tree view refreshed.");
  }, 1000);

  // ── Register commands ─────────────────────────────────────────────────────
  const openUICommand = vscode.commands.registerCommand(
    `${CONFIG_NS}.openUI`,
    () => {
      outputChannel.appendLine("[ACP Model Provider] openUI command called");
      agentUI.show();
    }
  );
  outputChannel.appendLine("[ACP Model Provider] openUI command registered");

  // ── Register "Manage ACP Agents" command ───────────────────────────────────
  const manageCmd = vscode.commands.registerCommand(
    `${CONFIG_NS}.manage`,
    async () => {
      outputChannel.appendLine("[ACP Model Provider] manage command called");
      const items: vscode.QuickPickItem[] = [
        {
          label: "$(refresh) Refresh agents",
          description: "Re-run agent discovery and reconnect",
        },
        {
          label: "$(symbol-property) Open Settings",
          description: "Open extension settings (acpModelProvider.agents)",
        },
      ];

      for (const [id, agent] of agentManager.agents) {
        const status = agent.connected ? "$(check) Connected" : "$(error) Disconnected";
        items.push({
          label: `${status} ${agent.config.label}`,
          description: `${id} · CLI: ${agent.config.cliCommand}`,
          detail: agent.connected
            ? `${agent.models.length} model(s)`
            : agent.lastError,
        });
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "ACP Agents",
      });

      if (!pick) return;

      if (pick.label.includes("Refresh")) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Refreshing ACP agents…" },
          async () => {
            await agentManager.initialize(configuredAgents);
            treeDataProvider.refresh();
            vscode.window.showInformationMessage("ACP agents refreshed.");
          }
        );
      } else if (pick.label.includes("Open Settings")) {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `@id:${CONFIG_NS}.agents`
        );
      }
    }
  );

  // ── Register reload command for development ───────────────────────────────────
  const reloadCmd = vscode.commands.registerCommand(
    `${CONFIG_NS}.reload`,
    () => {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  );

  // ── Register refresh agents command ─────────────────────────────────────────────
  const refreshAgentsCmd = vscode.commands.registerCommand(
    `${CONFIG_NS}.refreshAgents`,
    async () => {
      const configuredAgents = vscode.workspace
        .getConfiguration(CONFIG_NS)
        .get<AgentConfig[]>("agents", []);
      
      outputChannel.appendLine("[ACP Model Provider] Refreshing agents...");
      await agentManager.initialize(configuredAgents);
      treeDataProvider.refresh();
      outputChannel.appendLine("[ACP Model Provider] Agents refreshed.");
    }
  );

  // ── Wire up disposal ───────────────────────────────────────────────────────
  ctx.subscriptions.push(registration, manageCmd, openUICommand, reloadCmd, refreshAgentsCmd, outputChannel);
  ctx.subscriptions.push(agentUI);

  outputChannel.appendLine("[ACP Model Provider] Registered as vendor 'acp'.");
  outputChannel.appendLine("[ACP Model Provider] Activation complete.");
}

export function deactivate() {
  outputChannel?.appendLine("[ACP Model Provider] Deactivated.");
}
