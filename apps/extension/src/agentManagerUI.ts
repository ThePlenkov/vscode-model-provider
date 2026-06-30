import * as vscode from "vscode";
import { AgentManager, AgentConfig } from "./agentManager";

export class AgentManagerUI {
  private panel: vscode.WebviewPanel | undefined;
  private disposable: vscode.Disposable;

  constructor(private agentManager: AgentManager) {
    this.disposable = vscode.Disposable.from();
  }

  public show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "acpAgentManager",
      "ACP Agent Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getWebviewContent();
    this.updateWebview();

    // Handle messages from webview
    const messageHandler = this.panel.webview.onDidReceiveMessage(
      async (message: any) => {
        switch (message.command) {
          case "refresh":
            await this.refreshAgents();
            break;
          case "toggleAgent":
            await this.toggleAgent(message.agentId, message.enabled);
            break;
          case "addAgent":
            await this.addAgent(message.agent);
            break;
          case "editAgent":
            await this.editAgent(message.agentId, message.agent);
            break;
          case "deleteAgent":
            await this.deleteAgent(message.agentId);
            break;
          case "openSettings":
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "acpModelProvider.agents"
            );
            break;
        }
      }
    );
    
    this.disposable = messageHandler;

    // Update webview when agent manager changes
    (this.agentManager as any).on("connect", () => this.updateWebview());
    (this.agentManager as any).on("disconnect", () => this.updateWebview());

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async refreshAgents() {
    const config = vscode.workspace.getConfiguration("acpModelProvider");
    const agents = config.get<AgentConfig[]>("agents", []);
    
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Refreshing ACP agents…" },
      async () => {
        await this.agentManager.initialize(agents);
        this.updateWebview();
        vscode.window.showInformationMessage("ACP agents refreshed.");
      }
    );
  }

  private async toggleAgent(agentId: string, enabled: boolean) {
    const config = vscode.workspace.getConfiguration("acpModelProvider");
    const agents = config.get<AgentConfig[]>("agents", []);
    
    const updatedAgents = agents.map(agent => 
      agent.id === agentId ? { ...agent, enabled } : agent
    );
    
    await config.update("agents", updatedAgents, vscode.ConfigurationTarget.Global);
    this.updateWebview();
  }

  private async addAgent(agent: AgentConfig) {
    const config = vscode.workspace.getConfiguration("acpModelProvider");
    const agents = config.get<AgentConfig[]>("agents", []);
    
    // Check if agent ID already exists
    if (agents.some(a => a.id === agent.id)) {
      vscode.window.showErrorMessage(`Agent with ID "${agent.id}" already exists`);
      return;
    }
    
    const updatedAgents = [...agents, agent];
    await config.update("agents", updatedAgents, vscode.ConfigurationTarget.Global);
    this.updateWebview();
    vscode.window.showInformationMessage(`Agent "${agent.label}" added successfully`);
  }

  private async editAgent(agentId: string, updatedAgent: AgentConfig) {
    const config = vscode.workspace.getConfiguration("acpModelProvider");
    const agents = config.get<AgentConfig[]>("agents", []);
    
    // Check if new ID conflicts with existing agent (excluding current one)
    if (updatedAgent.id !== agentId && agents.some(a => a.id === updatedAgent.id)) {
      vscode.window.showErrorMessage(`Agent with ID "${updatedAgent.id}" already exists`);
      return;
    }
    
    const updatedAgents = agents.map(agent => 
      agent.id === agentId ? updatedAgent : agent
    );
    
    await config.update("agents", updatedAgents, vscode.ConfigurationTarget.Global);
    this.updateWebview();
    vscode.window.showInformationMessage(`Agent "${updatedAgent.label}" updated successfully`);
  }

  private async deleteAgent(agentId: string) {
    const config = vscode.workspace.getConfiguration("acpModelProvider");
    const agents = config.get<AgentConfig[]>("agents", []);
    
    const updatedAgents = agents.filter(agent => agent.id !== agentId);
    
    await config.update("agents", updatedAgents, vscode.ConfigurationTarget.Global);
    this.updateWebview();
    vscode.window.showInformationMessage(`Agent deleted successfully`);
  }

  private updateWebview() {
    if (!this.panel) return;

    const agents = [...this.agentManager.agents.entries()].map(([id, agent]: [string, any]) => ({
      id,
      label: agent.config.label,
      cliCommand: agent.config.cliCommand,
      cliArgs: agent.config.cliArgs || [],
      connected: agent.connected,
      models: agent.models,
      lastError: agent.lastError,
      enabled: agent.config.enabled !== false,
      modelMapping: agent.config.modelMapping,
    }));

    this.panel.webview.postMessage({ type: "agentsUpdate", agents });
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ACP Agent Manager</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      padding: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    
    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      color: var(--vscode-editor-foreground);
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    
    .actions {
      display: flex;
      gap: 10px;
    }
    
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    
    .primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    .secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .agent-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .agent-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    
    .agent-info {
      flex: 1;
    }
    
    .agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .agent-name {
      font-weight: 600;
      font-size: 16px;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    
    .status-connected {
      background: #4caf50;
      color: white;
    }
    
    .status-disconnected {
      background: #f44336;
      color: white;
    }
    
    .agent-details {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    
    .command-preview {
      font-family: 'Courier New', monospace;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      font-size: 12px;
      margin: 8px 0;
      word-break: break-all;
    }
    
    .models-list {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    
    .models-list strong {
      color: var(--vscode-editor-foreground);
    }
    
    .agent-controls {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
    }
    
    .toggle-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .toggle-label {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    
    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
      background: var(--vscode-slider-background);
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .toggle.active {
      background: var(--vscode-slider-activeBackground);
    }
    
    .toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    
    .toggle.active::after {
      transform: translateX(20px);
    }
    
    .error-message {
      color: #f44336;
      font-size: 13px;
      margin-top: 4px;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    
    .add-agent-form {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    }
    
    .form-group {
      margin-bottom: 12px;
    }
    
    .form-group label {
      display: block;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    
    .form-group input {
      width: 100%;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 13px;
    }
    
    .form-group input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    
    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    
    .action-buttons {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    
    .edit-btn, .delete-btn {
      padding: 4px 8px;
      font-size: 11px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    
    .edit-btn:hover, .delete-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .delete-btn {
      color: #f44336;
      border-color: #f44336;
    }
    
    .delete-btn:hover {
      background: #f44336;
      color: white;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 ACP Agent Manager</h1>
    <div class="actions">
      <button class="primary" id="addAgent">➕ Add Agent</button>
      <button class="secondary" id="openSettings">⚙️ Settings</button>
      <button class="secondary" id="refresh">🔄 Refresh</button>
    </div>
  </div>
  
  <div id="addAgentForm" class="add-agent-form" style="display: none;">
    <h3 id="formTitle">Add Custom Agent</h3>
    <input type="hidden" id="editingAgentId" value="">
    <div class="form-group">
      <label>Agent ID (slug for model prefix)</label>
      <input type="text" id="newAgentId" placeholder="e.g., my-custom-agent">
    </div>
    <div class="form-group">
      <label>Display Name</label>
      <input type="text" id="newAgentLabel" placeholder="e.g., My Custom Agent">
    </div>
    <div class="form-group">
      <label>CLI Command</label>
      <input type="text" id="newAgentCommand" placeholder="e.g., python-agent">
    </div>
    <div class="form-group">
      <label>CLI Arguments (space-separated)</label>
      <input type="text" id="newAgentArgs" placeholder="e.g., --acp --stdio">
    </div>
    <div class="form-group">
      <label>Model Name Mapping (JSON: {"original": "alias"})</label>
      <input type="text" id="newAgentMapping" placeholder='e.g., {"claude/sonnet-4.6": "sonnet"}'>
    </div>
    <div class="form-actions">
      <button class="primary" id="saveAgent">Save Agent</button>
      <button class="secondary" id="cancelAdd">Cancel</button>
    </div>
  </div>
  
  <div id="agentList" class="agent-list">
    <div class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <p>Loading agents...</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let agents = [];
    let allAgents = {}; // Store all agents with their data for editing
    
    function renderAgents(agentList) {
      agents = agentList;
      allAgents = {};
      agentList.forEach(agent => {
        allAgents[agent.id] = agent;
      });
      const container = document.getElementById('agentList');
      
      if (!agents || agents.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <p>No agents configured. Click "Add Agent" to add a custom agent.</p>
          </div>
        \`;
        return;
      }
      
      container.innerHTML = agents.map(agent => {
        const fullCommand = agent.cliCommand + (agent.cliArgs && agent.cliArgs.length ? ' ' + agent.cliArgs.join(' ') : '');
        const mappingInfo = agent.modelMapping ? \`<br><strong>Model Mapping:</strong> \${JSON.stringify(agent.modelMapping)}\` : '';
        
        return \`
        <div class="agent-card">
          <div class="agent-info">
            <div class="agent-header">
              <span class="agent-name">\${agent.label}</span>
              <span class="status-badge \${agent.connected ? 'status-connected' : 'status-disconnected'}">
                \${agent.connected ? '✓ Connected' : '✗ Disconnected'}
              </span>
            </div>
            <div class="agent-details">
              <strong>Slug:</strong> \${agent.id}<br>
              <strong>Command:</strong> <code>\${fullCommand}</code>\${mappingInfo}
            </div>
            \${agent.connected ? \`
              <div class="models-list">
                <strong>\${agent.models.length} model(s) available:</strong><br>
                \${agent.models.slice(0, 3).map(m => \`• \${m.id}\`).join('<br>')}
                \${agent.models.length > 3 ? \`<br>...and \${agent.models.length - 3} more\` : ''}
              </div>
            \` : \`
              <div class="error-message">Error: \${agent.lastError || 'Unknown error'}</div>
            \`}
          </div>
          <div class="agent-controls">
            <div class="toggle-container">
              <span class="toggle-label">Enabled</span>
              <div class="toggle \${agent.enabled ? 'active' : ''}" 
                   data-agent-id="\${agent.id}" 
                   data-enabled="\${agent.enabled}"
                   onclick="toggleAgent('\${agent.id}', \${!agent.enabled})">
              </div>
            </div>
            <div class="action-buttons">
              <button class="edit-btn" onclick="editAgent('\${agent.id}')">✏️ Edit</button>
              <button class="delete-btn" onclick="deleteAgent('\${agent.id}')">🗑️ Delete</button>
            </div>
          </div>
        </div>
      \`;}).join('');
    }
    
    function toggleAgent(agentId, enabled) {
      vscode.postMessage({
        command: 'toggleAgent',
        agentId,
        enabled
      });
    }
    
    function addAgent() {
      document.getElementById('formTitle').textContent = 'Add Custom Agent';
      document.getElementById('editingAgentId').value = '';
      document.getElementById('newAgentId').value = '';
      document.getElementById('newAgentLabel').value = '';
      document.getElementById('newAgentCommand').value = '';
      document.getElementById('newAgentArgs').value = '';
      document.getElementById('newAgentMapping').value = '';
      document.getElementById('newAgentId').disabled = false;
      document.getElementById('addAgentForm').style.display = 'block';
    }
    
    function editAgent(agentId) {
      const agent = allAgents[agentId];
      if (!agent) {
        console.error('Agent not found:', agentId, 'Available agents:', Object.keys(allAgents));
        return;
      }
      
      console.log('Editing agent:', agent);
      document.getElementById('formTitle').textContent = 'Edit Agent';
      document.getElementById('editingAgentId').value = agentId;
      document.getElementById('newAgentId').value = agent.id;
      document.getElementById('newAgentLabel').value = agent.label;
      document.getElementById('newAgentCommand').value = agent.cliCommand;
      document.getElementById('newAgentArgs').value = agent.cliArgs ? agent.cliArgs.join(' ') : '';
      document.getElementById('newAgentMapping').value = agent.modelMapping ? JSON.stringify(agent.modelMapping) : '';
      document.getElementById('newAgentId').disabled = true; // Can't change ID when editing
      document.getElementById('addAgentForm').style.display = 'block';
    }
    
    function deleteAgent(agentId) {
      if (confirm('Are you sure you want to delete this agent?')) {
        vscode.postMessage({
          command: 'deleteAgent',
          agentId
        });
      }
    }
    
    function cancelAdd() {
      document.getElementById('addAgentForm').style.display = 'none';
      // Clear form
      document.getElementById('editingAgentId').value = '';
      document.getElementById('newAgentId').value = '';
      document.getElementById('newAgentLabel').value = '';
      document.getElementById('newAgentCommand').value = '';
      document.getElementById('newAgentArgs').value = '';
      document.getElementById('newAgentMapping').value = '';
      document.getElementById('newAgentId').disabled = false;
    }
    
    function saveAgent() {
      const editingAgentId = document.getElementById('editingAgentId').value;
      const agentId = document.getElementById('newAgentId').value;
      const label = document.getElementById('newAgentLabel').value;
      const cliCommand = document.getElementById('newAgentCommand').value;
      const cliArgsStr = document.getElementById('newAgentArgs').value;
      const modelMappingStr = document.getElementById('newAgentMapping').value;
      
      if (!agentId || !label || !cliCommand) {
        alert('Please fill in ID, Label, and Command');
        return;
      }
      
      const cliArgs = cliArgsStr ? cliArgsStr.split(' ').filter(arg => arg) : [];
      let modelMapping = null;
      
      if (modelMappingStr) {
        try {
          modelMapping = JSON.parse(modelMappingStr);
        } catch (e) {
          alert('Invalid JSON for model mapping');
          return;
        }
      }
      
      const agentData = {
        id,
        label,
        cliCommand,
        cliArgs,
        modelMapping,
        enabled: true
      };
      
      if (editingAgentId) {
        vscode.postMessage({
          command: 'editAgent',
          agentId: editingAgentId,
          agent: agentData
        });
      } else {
        vscode.postMessage({
          command: 'addAgent',
          agent: agentData
        });
      }
      
      cancelAdd();
    }
    
    document.getElementById('addAgent').addEventListener('click', addAgent);
    document.getElementById('cancelAdd').addEventListener('click', cancelAdd);
    document.getElementById('saveAgent').addEventListener('click', saveAgent);
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
    
    document.getElementById('openSettings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });
    
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'agentsUpdate') {
        renderAgents(message.agents);
      }
    });
    
    // Request initial data
    vscode.postMessage({ command: 'getAgents' });
  </script>
</body>
</html>`;
  }

  public dispose() {
    this.panel?.dispose();
    this.disposable.dispose();
  }
}