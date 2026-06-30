import * as vscode from "vscode";
import { AgentManager } from "./agentManager";

export class AgentTreeDataProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeItem | void | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private agentManager: AgentManager) {}

  getTreeItem(element?: AgentTreeItem): vscode.ProviderResult<AgentTreeItem> {
    return element;
  }

  getChildren(element?: AgentTreeItem): vscode.ProviderResult<AgentTreeItem[]> {
    console.log('getChildren called, element:', element);
    if (element) {
      return Promise.resolve([]);
    }
    
    // Root level - show all agents
    const items: AgentTreeItem[] = [];
    for (const [id, agent] of this.agentManager.agents) {
      items.push(new AgentTreeItem(
        agent.config.label,
        vscode.TreeItemCollapsibleState.None,
        agent.connected ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon('error'),
        {
          id,
          connected: agent.connected,
          modelCount: agent.models.length,
          command: agent.config.cliCommand,
          args: agent.config.cliArgs,
          lastError: agent.lastError
        }
      ));
    }
    console.log('Returning', items.length, 'items');
    return Promise.resolve(items);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly iconPath?: vscode.ThemeIcon | vscode.Uri,
    public readonly metadata?: {
      id: string;
      connected: boolean;
      modelCount: number;
      command: string;
      args: string[];
      lastError?: string;
    }
  ) {
    super(label, collapsibleState);
    this.iconPath = iconPath;
    
    if (metadata) {
      if (metadata.connected) {
        this.description = `${metadata.modelCount} model(s)`;
        this.tooltip = `CLI: ${metadata.command} ${metadata.args.join(' ')}`;
      } else {
        this.description = metadata.lastError || 'Disconnected';
        this.tooltip = `Error: ${metadata.lastError || 'Unknown error'}\n\nCLI: ${metadata.command} ${metadata.args.join(' ')}`;
      }
    }
  }
}
