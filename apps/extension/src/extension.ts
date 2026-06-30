/**
 * Thin VS Code shell for the ACP Model Provider.
 *
 * This file is the *only* place in `apps/extension/src/` that knows about
 * `vscode`. Everything else (the provider, the session pool, the bridges,
 * the discovery layer) lives in `@theplenkov/acpify`. Per-agent adapters
 * (Claude Code, Gemini CLI, Codex, OpenCode, …) live in their own packages.
 *
 * PR 09 will replace `AcpBareboneProvider` with `AcpModelProvider` (the
 * real registry). For the barebone, we register an empty provider that
 * proves the activation path works.
 */

import * as vscode from "vscode";
// Relative import (not `@theplenkov/acpify`) so tsdown treats this as a
// local file and bundles `AcpBareboneProvider` directly into `dist/extension.mjs`.
// The npm workspace dependency in package.json is preserved for the typecheck
// path, but at bundle time we use the relative path so the resulting `.vsix`
// is self-contained.
import { AcpBareboneProvider } from "../../../packages/acpify/src/provider/barebone.js";

const OUTPUT_CHANNEL_NAME = "ACP Model Provider";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("[ACP Model Provider] Activating barebone shell…");

  const provider = new AcpBareboneProvider();
  const registration = vscode.lm.registerLanguageModelChatProvider("acp", provider);

  ctx.subscriptions.push(registration, output);
  output.appendLine(
    "[ACP Model Provider] Registered as vendor 'acp'. " +
    "PR 09 will wire the model registry.",
  );
}

export function deactivate(): void {
  // No persistent resources to release in the barebone. The full session
  // pool is added by subagent PR 02 (see docs/agent-tasks/02-session-pool.md).
}