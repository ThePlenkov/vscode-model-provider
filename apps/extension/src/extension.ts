/**
 * Barebone entry point.
 *
 * This file is the *minimum* needed to register the ACP vendor with the
 * VS Code `LanguageModelChatProvider` API so the extension packages, loads,
 * and shows up in the model picker. It exposes 0 models until a subagent
 * PR wires real agents in. See `docs/architecture.md` §3.6 and
 * `docs/agent-tasks/09-registry.md` for the full wiring plan.
 */

import * as vscode from "vscode";
import { AcpProvider } from "./provider.js";

const OUTPUT_CHANNEL_NAME = "ACP Model Provider";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("[ACP Model Provider] Activating barebone…");

  const provider = new AcpProvider();
  const registration = vscode.lm.registerLanguageModelChatProvider("acp", provider);

  ctx.subscriptions.push(registration, output);
  output.appendLine("[ACP Model Provider] Registered as vendor 'acp' (0 models).");
}

export function deactivate(): void {
  // No persistent resources to release in the barebone. The full session
  // pool is added by subagent PR 02 (see docs/agent-tasks/02-session-pool.md).
}
