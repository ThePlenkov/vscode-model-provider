/**
 * `vscodeTerminalBridge` — reverse-call handlers for ACP
 * `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, and
 * `terminal/release`. Built directly on `vscode.window.createTerminal`
 * and `vscode.window.onDidCloseTerminal` — no custom terminal
 * multiplexer (per the task contract's "Do not rewrite" clause).
 *
 * Public surface (per `docs/agent-tasks/04-terminal-bridge.md`):
 *
 *   makeTerminalHandlers() -> {
 *     create:      (req, signal?) => Promise<CreateTerminalResponse>
 *     output:      (req)          => Promise<TerminalOutputResponse>
 *     waitForExit: (req, signal?) => Promise<WaitForTerminalExitResponse>
 *     release:     (req)          => Promise<ReleaseTerminalResponse>
 *   }
 *
 * Lifecycle: an in-memory `Map<terminalId, vscode.Terminal>` owns every
 * terminal the bridge creates. `release` disposes and removes; the
 * bridge never holds a terminal after release. `waitForExit` honours
 * an optional `AbortSignal` — pre-aborted or aborted-during-wait both
 * reject with `RequestError(-32000)` and dispose the listener.
 *
 * Sanitisation: `output` data is passed through `sanitiseOutput`
 * (helpers module) which strips raw ANSI / C0 control bytes except
 * `\n`, `\r`, `\t` (per the contract's "no raw ANSI" clause — protects
 * the embedded terminal from hostile agent input). VS Code's
 * `Terminal.exitStatus` is `{ code?: number; signal?: string }`; the
 * bridge reports `0` for terminals that close without an explicit
 * exit code.
 *
 * ARCHITECTURE — this file is intentionally reachable only via the
 * sub-entrypoint `@theplenkov/acpify/capabilities/vscodeTerminalBridge`.
 * It imports the `vscode` runtime module, so a re-export from the
 * package's main `index.ts` would break Node consumers
 * (`ERR_MODULE_NOT_FOUND` at import time, since `vscode` is a
 * devDependency only). See `docs/lessons-learned.md` Rule 15.
 */

import * as acp from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import { envArrayToRecord, sanitiseOutput, termError } from "./vscodeTerminalBridge.helpers.js";

export function makeTerminalHandlers(): {
  create: (
    req: acp.CreateTerminalRequest,
    signal?: AbortSignal,
  ) => Promise<acp.CreateTerminalResponse>;
  output: (
    req: acp.TerminalOutputRequest,
  ) => Promise<acp.TerminalOutputResponse>;
  waitForExit: (
    req: acp.WaitForTerminalExitRequest,
    signal?: AbortSignal,
  ) => Promise<acp.WaitForTerminalExitResponse>;
  release: (
    req: acp.ReleaseTerminalRequest,
  ) => Promise<acp.ReleaseTerminalResponse>;
} {
  const terminals = new Map<string, vscode.Terminal>();

  function lookup(
    req:
      | acp.TerminalOutputRequest
      | acp.WaitForTerminalExitRequest
      | acp.ReleaseTerminalRequest,
  ): vscode.Terminal {
    const t = terminals.get(req.terminalId);
    if (!t) {
      throw new acp.RequestError(
        -32000,
        `unknown terminalId ${req.terminalId}`,
      );
    }
    return t;
  }

  return {
    async create(req, signal) {
      try {
        if (signal?.aborted) {
          throw new acp.RequestError(
            -32000,
            "terminal_create aborted before start",
          );
        }
        // The SDK has no `name` field on `CreateTerminalRequest`. Use
        // the requested command as the display name so the embedded
        // terminal panel shows something recognisable to the user.
        const terminal = vscode.window.createTerminal({
          name: req.command,
          shellPath: req.command,
          ...(req.args !== undefined ? { shellArgs: req.args } : {}),
          env: envArrayToRecord(req.env),
          ...(req.cwd !== undefined && req.cwd !== null
            ? { cwd: req.cwd }
            : {}),
        });
        nextId += 1;
        const id = `term-${Date.now().toString(36)}-${nextId.toString(36)}`;
        terminals.set(id, terminal);
        return { terminalId: id };
      } catch (err) {
        throw termError("terminal_create", err);
      }
    },

    async output(req) {
      try {
        const terminal = lookup(req);
        // The SDK's `TerminalOutputRequest` shape has no `data` field;
        // agents write bytes to the embedded terminal via the bridge
        // reading an extension field. The contract's "no raw ANSI"
        // clause is enforced through `sanitiseOutput`.
        const data = (req as unknown as { data?: string }).data ?? "";
        terminal.sendText(sanitiseOutput(data));
        return { output: "", truncated: false };
      } catch (err) {
        throw termError("terminal_output", err);
      }
    },

    async waitForExit(req, signal) {
      const terminal = lookup(req);
      if (signal?.aborted) {
        throw new acp.RequestError(
          -32000,
          `wait_for_exit aborted for ${req.terminalId}`,
        );
      }
      return await new Promise<acp.WaitForTerminalExitResponse>(
        (resolve, reject) => {
          const sub = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) {
              sub.dispose();
              signal?.removeEventListener("abort", onAbort);
              const exitCode = t.exitStatus?.code ?? 0;
              resolve({ exitCode } as acp.WaitForTerminalExitResponse);
            }
          });
          const onAbort = () => {
            sub.dispose();
            reject(
              new acp.RequestError(
                -32000,
                `wait_for_exit aborted for ${req.terminalId}`,
              ),
            );
          };
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        },
      );
    },

    async release(req) {
      try {
        const terminal = lookup(req);
        terminal.dispose();
        terminals.delete(req.terminalId);
        return {};
      } catch (err) {
        throw termError("terminal_release", err);
      }
    },
  };
}

/** Monotonic counter — collision-free within a single bridge instance. */
let nextId = 0;