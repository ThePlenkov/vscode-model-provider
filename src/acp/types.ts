/**
 * ACP (Agent Client Protocol) types.
 * Based on https://agentclientprotocol.com/protocol/overview
 *
 * ACP is JSON-RPC 2.0 over stdio. All messages have the shape:
 *   Request:  { id, method, params }
 *   Response: { id, result }
 *   Error:    { id, error: { code, message } }
 *   Notify:   { method, params }  (no id)
 */

export const ACP_PROTOCOL_VERSION = "1.0.0";

// ─── Agent capabilities advertised in `initialize` result ────────────────────

export interface AcpAgentCapability {
  loadSession?: true;
  auth?: {
    logout?: true;
  };
}

export interface AcpClientCapability {
  fs?: {
    readTextFile?: true;
    writeTextFile?: true;
  };
  terminal?: true;
}

export interface AcpModelInfo {
  /** e.g. "claude-3-5-sonnet-20241022" */
  id: string;
  /** e.g. "Claude 3.5 Sonnet" */
  name: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion: string;
  agentCapabilities: AcpAgentCapability;
  /** Models advertised by the agent during init */
  models?: AcpModelInfo[];
  instructions?: string;
}

export interface AcpInitializeParams {
  protocolVersion: string;
  clientCapabilities: AcpClientCapability;
}

export interface AcpAuthenticateParams {
  apiKey?: string;
  token?: string;
  [key: string]: unknown;
}

export interface AcpSessionNewParams {
  cwd?: string;
  mcpServers?: unknown[];
  model?: string;
}

export interface AcpSessionNewResult {
  sessionId: string;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentPart[];
}

export interface AcpSessionSetModeParams {
  sessionId: string;
  mode: string;
}

// ─── Content parts ────────────────────────────────────────────────────────────

export type AcpContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string }
  | { type: "resource"; resource: AcpResource };

export interface AcpResource {
  /** e.g. "file", "url" */
  type: string;
  uri: string;
  mimeType?: string;
}

// ─── Session/update notification ─────────────────────────────────────────────

export type AcpSessionUpdateParams =
  | AcpMessageChunk
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPlan
  | AcpAvailableCommandsUpdate
  | AcpModeChange
  | AcpSessionEnded;

export interface AcpMessageChunk {
  type: "message";
  role: "user" | "assistant" | "thought";
  content: AcpContentPart[];
}

export interface AcpToolCall {
  type: "tool_call";
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AcpToolCallUpdate {
  type: "tool_call_update";
  callId: string;
  content: AcpContentPart[];
}

export interface AcpPlan {
  type: "plan";
  role: "user" | "assistant";
  content: AcpContentPart[];
}

export interface AcpAvailableCommandsUpdate {
  type: "available_commands";
  commands: AcpCommand[];
}

export interface AcpCommand {
  name: string;
  description?: string;
}

export interface AcpModeChange {
  type: "mode_change";
  mode: string;
}

export interface AcpSessionEnded {
  type: "session_end";
  reason: string;
}

export interface AcpSessionPromptResult {
  stopReason: string;
}

// ─── Internal: JSON-RPC envelope ─────────────────────────────────────────────

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
