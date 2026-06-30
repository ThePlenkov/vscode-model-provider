/**
 * ACP (Agent Client Protocol) v1 types.
 * Based on https://agentclientprotocol.com
 *
 * Schema: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/
 * Meta:   https://agentclientprotocol.com/protocol/v1/schema
 *
 * ACP is JSON-RPC 2.0 over stdio. All messages:
 *   Request:  { jsonrpc: "2.0", id, method, params }
 *   Response: { jsonrpc: "2.0", id, result }
 *   Error:    { jsonrpc: "2.0", id, error: { code, message, data? } }
 *   Notify:   { jsonrpc: "2.0", method, params }  (no id)
 */

// ─── Custom extension: model discovery ───────────────────────────────────────────
// ACP v1 does not include model discovery in the core spec. Agents like Claude Code
// may still advertise a `models` array in the initialize response as a custom
// extension. This type mirrors that field.

/** Model advertised by the agent during `initialize`. */
export interface AcpModelInfo {
  /** e.g. "claude-3-5-sonnet-20241022" */
  id: string;
  /** e.g. "Claude 3.5 Sonnet" */
  name: string;
  description?: string;
}

// ─── Protocol version ──────────────────────────────────────────────────────────

/** Integer protocol version (e.g. 1). bumped only for breaking changes. */
export type AcpProtocolVersion = number;

// ─── Client → Agent requests ──────────────────────────────────────────────────

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpClientCapabilities {
  /** File system capabilities supported by the client. */
  fs?: AcpFileSystemCapabilities;
  /** Whether the client supports all terminal/* methods. */
  terminal?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpFileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpInitializeParams {
  /** The latest protocol version supported by the client. */
  protocolVersion: AcpProtocolVersion;
  /** Capabilities the client supports. */
  clientCapabilities?: AcpClientCapabilities;
  /** Information about the client (name, version). */
  clientInfo?: AcpClientInfo;
  _meta?: Record<string, unknown> | null;
}

export interface AcpAgentInfo {
  name: string;
  version: string;
}

export interface AcpAuthMethod {
  type: "agent" | "id";
  description?: string;
  id?: string;
}

export interface AcpSessionCapabilities {
  /** Whether the agent supports session/list. */
  list?: Record<string, unknown> | null;
  /** Whether the agent supports session/delete. */
  delete?: Record<string, unknown> | null;
  /** Whether the agent supports session/close. */
  close?: Record<string, unknown> | null;
  /** Whether the agent supports session/resume. */
  resume?: Record<string, unknown> | null;
  /** Whether the agent supports additionalDirectories on session lifecycle. */
  additionalDirectories?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpMcpCapabilities {
  /** Agent supports McpServer::Http. */
  http?: boolean;
  /** Agent supports McpServer::Sse. */
  sse?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpPromptCapabilities {
  /** Agent supports ContentBlock::Audio in session/prompt. */
  audio?: boolean;
  /** Agent supports embedded context in session/prompt. */
  embeddedContext?: boolean;
  /** Agent supports ContentBlock::Image in session/prompt. */
  image?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface AcpAgentCapabilities {
  /** Authentication-related capabilities. */
  auth?: Record<string, unknown>;
  /** Whether the agent supports session/load. */
  loadSession?: boolean;
  /** MCP capabilities supported by the agent. */
  mcpCapabilities?: AcpMcpCapabilities;
  /** Prompt capabilities in session/prompt. */
  promptCapabilities?: AcpPromptCapabilities;
  /** Session lifecycle and prompt capabilities. */
  sessionCapabilities?: AcpSessionCapabilities;
  _meta?: Record<string, unknown> | null;
}

export interface AcpInitializeResult {
  /**
   * The protocol version the client specified if supported by the agent,
   * or the latest protocol version supported by the agent.
   */
  protocolVersion: AcpProtocolVersion;
  /** Capabilities the agent supports. */
  agentCapabilities: AcpAgentCapabilities;
  /** Information about the agent (name, version). */
  agentInfo?: AcpAgentInfo;
  /** Authentication methods supported by the agent. */
  authMethods?: AcpAuthMethod[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpAuthenticateParams {
  /** Which authentication method to use. */
  type?: "agent" | "id";
  id?: string;
  apiKey?: string;
  token?: string;
  [key: string]: unknown;
}

export interface AcpSessionNewParams {
  /** Working directory for this session. Must be absolute. */
  cwd: string;
  /** List of MCP servers to connect to. */
  mcpServers?: AcpMcpServer[];
  /** Additional workspace roots for this session. */
  additionalDirectories?: string[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpMcpServer {
  name: string;
  /** Stdio transport for MCP server. */
  stdio?: {
    command: string;
    args?: string[];
    env?: AcpEnvVariable[];
    cwd?: string;
  };
  /** HTTP transport for MCP server. */
  http?: {
    url: string;
    headers?: AcpHttpHeader[];
  };
  /** SSE transport for MCP server. */
  sse?: {
    url: string;
    headers?: AcpHttpHeader[];
  };
}

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionModeState {
  availableModes: AcpSessionMode[];
  currentModeId: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionConfigSelectOption {
  id: string;
  label: string;
}

export interface AcpSessionConfigSelect {
  options: AcpSessionConfigSelectOption[];
}

export type AcpSessionConfigValue =
  | { type: "select"; select: AcpSessionConfigSelect }
  | { type: "unknown" };

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  value: AcpSessionConfigValue;
}

export interface AcpSessionNewResult {
  /** Unique identifier for the created session. */
  sessionId: string;
  /** Initial session configuration options if supported. */
  configOptions?: AcpSessionConfigOption[] | null;
  /** Initial mode state if supported. */
  modes?: AcpSessionModeState | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionListParams {
  /** Filter sessions by working directory (must be absolute). */
  cwd?: string | null;
  /** Opaque cursor from previous response's nextCursor. */
  cursor?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  additionalDirectories?: string[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionListResult {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionResumeParams {
  /** The session ID to resume. */
  sessionId: string;
  /** Working directory for this session. */
  cwd: string;
  /** MCP servers to connect to for this session. */
  mcpServers?: AcpMcpServer[];
  /** Additional workspace roots to activate for this session. */
  additionalDirectories?: string[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionResumeResult {
  /** Initial session configuration options if supported. */
  configOptions?: AcpSessionConfigOption[] | null;
  /** Initial mode state if supported. */
  modes?: AcpSessionModeState | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionDeleteParams {
  sessionId: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpSessionDeleteResult = Record<string, unknown> | null;

export interface AcpSessionCloseParams {
  sessionId: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpSessionCloseResult = Record<string, unknown> | null;

// ─── Prompt / content types ───────────────────────────────────────────────────

export type AcpContentPart =
  | AcpTextContent
  | AcpImageContent
  | AcpAudioContent
  | AcpEmbeddedResource;

export interface AcpTextContent {
  type: "text";
  text: string;
}

export interface AcpImageContent {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  mimeType?: string;
}

export interface AcpAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}

export interface AcpEmbeddedResource {
  type: "resource";
  resource: AcpResourceLink;
}

export interface AcpResourceLink {
  uri: string;
  name: string;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  annotations?: unknown | null;
}

export interface AcpPromptParams {
  sessionId: string;
  /** Content blocks composing the user's message. */
  prompt: AcpContentPart[];
  _meta?: Record<string, unknown> | null;
}

export type AcpStopReason =
  | "end_turn"
  | "max_turn_requests"
  | "max_tokens"
  | "stop_sequence"
  | "model_limit"
  | "completed"
  | "in_progress"
  | "cancelled"
  | string;

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionSetModeParams {
  sessionId: string;
  modeId: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpSessionSetModeResult = Record<string, unknown> | null;

export interface AcpSessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionSetConfigOptionResult {
  configOptions: AcpSessionConfigOption[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpLogoutResult {
  _meta?: Record<string, unknown> | null;
}

// ─── Agent → Client notifications (session/update) ───────────────────────────

/**
 * Discriminated union of all session update types.
 * The `sessionUpdate` field is the discriminator.
 */
export type AcpSessionUpdate =
  | AcpUserMessageChunk
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | AcpAvailableCommandsUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpSessionInfoUpdate
  | AcpUsageUpdate;

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
  _meta?: Record<string, unknown> | null;
}

export interface AcpUserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: AcpContentPart[];
}

export interface AcpAgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: AcpContentPart[];
}

export interface AcpAgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: AcpContentPart[];
}

export type AcpToolKind =
  | "read"
  | "edit"
  | "search"
  | "execute"
  | "resource"
  | "fetch"
  | "create"
  | "move"
  | "delete"
  | "select";

export type AcpToolCallStatus =
  | "in_progress"
  | "completed"
  | "error"
  | "cancelled";

export interface AcpToolCallLocation {
  path: string;
  line?: number;
  _meta?: Record<string, unknown> | null;
}

export interface AcpToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  locations?: AcpToolCallLocation[];
  content?: AcpContentPart[];
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  _meta?: Record<string, unknown> | null;
}

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  content?: AcpContentPart[] | null;
  title?: string | null;
  status?: AcpToolCallStatus;
  kind?: AcpToolKind;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  _meta?: Record<string, unknown> | null;
}

export type AcpPlanEntryStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AcpPlanEntryPriority =
  | "low"
  | "medium"
  | "high";

export interface AcpPlanEntry {
  status: AcpPlanEntryStatus;
  content: string;
  priority: AcpPlanEntryPriority;
  _meta?: Record<string, unknown> | null;
}

export interface AcpPlanUpdate {
  sessionUpdate: "plan";
  entries: AcpPlanEntry[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpAvailableCommandInput {
  type: "unstructured" | "select";
  options?: string[];
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: AcpAvailableCommandInput;
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  commands: AcpAvailableCommand[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpCurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  mode: AcpSessionModeState;
  _meta?: Record<string, unknown> | null;
}

export interface AcpConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: AcpSessionConfigOption[];
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpUsageUpdate {
  sessionUpdate: "usage_update";
  /** Total context window size in tokens. */
  size: number;
  /** Tokens currently in context. */
  used: number;
  /** Cumulative session cost. */
  cost?: AcpCost | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpCost {
  amount: number;
  currency: string;
}

// ─── Agent → Client: permission request ──────────────────────────────────────

export interface AcpToolCallForPermission {
  name: string;
  input?: Record<string, unknown>;
}

export type AcpPermissionOptionKind =
  | "allow_always"
  | "allow_once"
  | "reject_always"
  | "reject_once";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpSessionRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallForPermission;
  options: AcpPermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export type AcpRequestPermissionOutcome =
  | { type: "selected"; optionId: string }
  | { type: "cancelled" };

export interface AcpSessionRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
  _meta?: Record<string, unknown> | null;
}

// ─── Agent → Client: terminal ─────────────────────────────────────────────────

export interface AcpTerminalOutputParams {
  sessionId: string;
  terminalId: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpTerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpTerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: AcpTerminalExitStatus | null;
  _meta?: Record<string, unknown> | null;
}

// ─── Agent → Client: fs ───────────────────────────────────────────────────────

export interface AcpFsReadTextFileParams {
  path: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpFsReadTextFileResult {
  contents: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpFsWriteTextFileParams {
  path: string;
  contents: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpFsWriteTextFileResult = Record<string, unknown> | null;

// ─── Client → Agent: terminal ────────────────────────────────────────────────

export interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: AcpEnvVariable[];
  outputByteLimit?: number | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpTerminalKillParams {
  sessionId: string;
  terminalId: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpTerminalKillResult = Record<string, unknown> | null;

export interface AcpTerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpTerminalWaitForExitResult {
  exitCode?: number | null;
  signal?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpTerminalReleaseParams {
  sessionId: string;
  terminalId: string;
  _meta?: Record<string, unknown> | null;
}

export type AcpTerminalReleaseResult = Record<string, unknown> | null;

// ─── JSON-RPC envelope ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
