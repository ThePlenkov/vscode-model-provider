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
 *
 * PR 01 (this PR) also instantiates a `CliAcpClient` and registers no-op
 * reverse-call handlers. The pool (PR 02) will replace the in-handler
 * logging with a real session pool. The bridges (PRs 03–06) will replace
 * each no-op handler below with the real implementation. The barebone
 * import stays — it is deleted by PR 09.
 */

import * as vscode from "vscode";
// Relative imports (not `@theplenkov/acpify`) so tsdown treats these as
// local source files and bundles them directly into `dist/extension.mjs`.
// The resulting `.vsix` is self-contained: only the `vscode` module is
// left external.
//
// For typecheck, `apps/extension/tsconfig.json` sets `rootDir` to the repo
// root and includes the package's source files, so the imports resolve
// cleanly and tsc validates both files. The npm workspace dependency in
// `apps/extension/package.json` is still required for IDE hover and
// jump-to-definition.
import { AcpBareboneProvider } from "../../../packages/acpify/src/provider/barebone.js";
import { CliAcpClient } from "../../../packages/acpify/src/client/cliClient.js";
import type { CliClientHandlers } from "../../../packages/acpify/src/client/cliClient.js";

const OUTPUT_CHANNEL_NAME = "ACP Model Provider";

/**
 * No-op reverse-call handlers. PRs 03–06 replace each of these with the
 * real implementation (vscodeFsBridge, vscodeTerminalBridge, …).
 * `onSessionUpdate` logs to the output channel for now; PR 02 replaces
 * this with the session pool.
 */
function noopHandlers(output: vscode.OutputChannel): CliClientHandlers {
  return {
    onSessionUpdate: (n) => {
      output.appendLine(
        `[session/update] session=${n.sessionId} kind=${n.update.sessionUpdate}`,
      );
    },
    onReadTextFile: async () => {
      throw new Error("fs/read_text_file: no bridge wired (PR 03)");
    },
    onWriteTextFile: async () => {
      throw new Error("fs/write_text_file: no bridge wired (PR 03)");
    },
    onCreateTerminal: async () => {
      throw new Error("terminal/create: no bridge wired (PR 04)");
    },
    onTerminalOutput: async () => {
      throw new Error("terminal/output: no bridge wired (PR 04)");
    },
    onWaitForExit: async () => {
      throw new Error("terminal/wait_for_exit: no bridge wired (PR 04)");
    },
    onReleaseTerminal: async () => {
      throw new Error("terminal/release: no bridge wired (PR 04)");
    },
    onRequestPermission: async () => {
      throw new Error("session/request_permission: no bridge wired (PR 05)");
    },
  };
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("[ACP Model Provider] Activating barebone shell…");

  /* Barebone provider — keeps the activation path wired until PR 09. */
  const provider = new AcpBareboneProvider();
  const registration = vscode.lm.registerLanguageModelChatProvider("acp", provider);

  /* SDK-backed ACP client — wired in alongside, not in place of, the
     barebone. Construct only; actual `connect(...)` happens when the
     session pool (PR 02) is ready to dispatch. No CLI is spawned yet. */
  const client = new CliAcpClient();
  void client;
  void noopHandlers(output);

  /* Session pool — constructed but not yet dispatching. The pool takes
     a `clientFactory` (returns a fresh `CliAcpClient` per session) and
     a `connectFn` (runs `initialize` + `session/new` on the client and
     returns the session id). Wiring that to a real CLI is PR 07/10's
     job; for now the pool is held so PR 02's lifecycle is testable
     without spawning a process. */
  const pool = new SessionPool(
    () => new CliAcpClient(),
    async (_c, _key) => {
      throw new Error("SessionPool.connectFn is not wired (PR 07/10)");
    },
  );
  void pool;

  ctx.subscriptions.push(registration, output, {
    dispose: () => {
      void pool.shutdownAll();
      void client.disconnect();
    },
  });

  output.appendLine(
    "[ACP Model Provider] Registered as vendor 'acp'. " +
    "Barebone provider + CliAcpClient shell online. " +
    "SessionPool constructed; PR 07/10 wires the real connectFn. " +
    "PR 09 swaps the barebone for the real registry.",
  );
}

export function deactivate(): void {
  // The pool shuts itself down via its `dispose` subscription above.
}
