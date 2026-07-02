/**
 * Helpers for `vscodeTerminalBridge`. Split out (Rule 14, lessons-learned)
 * to keep the main file under the ~200 LOC budget before CodeScene
 * flags it. Each helper is a small pure function; nothing here reaches
 * into the bridge's mutable state — that's all in `vscodeTerminalBridge.ts`.
 *
 * Keeping these in their own file also means the main file can
 * `import { … } from "./…helpers.js"` and the diff for a CodeScene
 * "complexity" complaint is a one-line import instead of an
 * inline-extraction refactor.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

/** Single error code for every terminal-bridge failure (per contract). */
const TERMINAL_ERROR_CODE = -32000;

/**
 * Wrap any thrown value as a protocol-compliant `RequestError`.
 * Re-throw already-formed `RequestError`s as-is so the call-site can
 * distinguish protocol errors (e.g. user-cancelled) from infrastructure
 * failures without losing the original code.
 */
export function termError(op: string, cause: unknown): acp.RequestError {
  if (cause instanceof RequestError) return cause;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new RequestError(TERMINAL_ERROR_CODE, `${op} failed: ${msg}`);
}

/**
 * Strip raw C0/C1 control bytes from terminal output. The contract
 * forbids ANSI escape codes — keep `\n`, `\r`, `\t` only.
 *   - 0x00-0x08 → NUL..BS        (stripped, except \t which is 0x09)
 *   - 0x09      → HT (\t)        (kept)
 *   - 0x0A      → LF (\n)        (kept)
 *   - 0x0B      → VT             (stripped)
 *   - 0x0C      → FF             (stripped)
 *   - 0x0D      → CR (\r)        (kept)
 *   - 0x0E-0x1F → SO..US        (stripped, includes ESC at 0x1B)
 *   - 0x7F      → DEL            (stripped)
 */
export function sanitiseOutput(data: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip C0/C1 control bytes
  return data.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Convert ACP `env: EnvVariable[]` → VS Code `TerminalOptions.env`. */
export function envArrayToRecord(
  env: ReadonlyArray<acp.EnvVariable> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of env ?? []) out[name] = value;
  return out;
}