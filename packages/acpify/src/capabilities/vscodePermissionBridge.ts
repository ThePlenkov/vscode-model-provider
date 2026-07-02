/**
 * `vscodePermissionBridge` — reverse-call handler for ACP
 * `session/request_permission`. Built directly on
 * `vscode.window.showQuickPick` — no custom permission UI framework
 * (per the task contract's "Do not rewrite" clause).
 *
 * Per `docs/agent-tasks/05-permission-bridge.md`:
 *
 *   makePermissionHandlers(store, scope) -> {
 *     requestPermission: (req, signal?) => Promise<RequestPermissionResponse>
 *   }
 *
 * Behaviour:
 *   1. Pre-aborted signal → return cancelled without prompt.
 *   2. PermissionStore.match hit ("allow" | "deny") → return that
 *      decision as the response `optionId` ("allow" / "deny") without
 *      showing any UI.
 *   3. Otherwise build a QuickPick from request.options plus two
 *      sentinels (`__allow_always`, `__deny_always`). Forward the
 *      AbortSignal as a `vscode.CancellationToken` (the third
 *      positional argument of `showQuickPick`).
 *   4. User picks a request option → return its optionId as-is.
 *      User picks `__allow_always` / `__deny_always` → persist a new
 *      PermissionRule to the store and return "allow" / "deny".
 *      Cancel → return cancelled.
 *
 * Persistence: `__allow_always` / `__deny_always` adds a new rule via
 * `PermissionStore.save`. The pattern is the JSON-stringified
 * `toolCall.rawInput` so subsequent identical inputs match.
 *
 * ARCHITECTURE — this file is intentionally reachable only via the
 * sub-entrypoint `@theplenkov/acpify/capabilities/vscodePermissionBridge`.
 * It imports the `vscode` runtime module, so a re-export from the
 * package's main `index.ts` would break Node consumers
 * (`ERR_MODULE_NOT_FOUND` at import time, since `vscode` is a
 * devDependency only). See `docs/lessons-learned.md` Rule 15.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import type { PermissionStore } from "../session/permissions.js";

/** Sentinel option IDs (not part of the ACP protocol — bridge-local). */
const ALLOW_ALWAYS = "__allow_always";
const DENY_ALWAYS = "__deny_always";

/**
 * Response `optionId` values. The contract doc declares that the
 * store short-circuit returns `optionId: "allow"` / `"deny"` — these
 * are bridge-decision labels, NOT pulled from the request's options.
 * Same applies to the `__allow_always` / `__deny_always` sentinel
 * picks: the bridge rewrites them to these labels.
 */
const ALLOW_OPTION_ID = "allow";
const DENY_OPTION_ID = "deny";

/** Narrow shape used internally; VS Code's `QuickPickItem` adds `label`. */
type PickEntry = { readonly optionId: string; readonly label: string };

/**
 * Build the QuickPick items: every request option (mapped to
 * `{ optionId, label }`) plus the two sentinels. We avoid passing the
 * SDK's `PermissionOption` objects directly because VS Code's
 * `showQuickPick<T extends QuickPickItem>` requires `label`.
 */
function buildPickItems(req: acp.RequestPermissionRequest): PickEntry[] {
  return [
    ...req.options.map(
      (o): PickEntry => ({ optionId: o.optionId, label: o.name }),
    ),
    { optionId: ALLOW_ALWAYS, label: "Allow always" },
    { optionId: DENY_ALWAYS, label: "Deny always" },
  ];
}

/**
 * Convert the `AbortSignal` to a VS Code `CancellationToken` so the
 * `showQuickPick` UI closes when the signal is aborted. VS Code's
 * showQuickPick signature is `(items, options, token)` — the token
 * is the THIRD positional argument; the options bag does not
 * accept a signal (Codacy HIGH RISK finding).
 */
function abortSignalToToken(
  signal: AbortSignal | undefined,
): vscode.CancellationToken | undefined {
  if (!signal) return undefined;
  // `CancellationTokenSource` is the only public surface for creating
  // a token whose cancellation we can wire to an external signal.
  const source = new vscode.CancellationTokenSource();
  const onAbort = () => {
    source.cancel();
    signal.removeEventListener("abort", onAbort);
  };
  if (signal.aborted) {
    source.cancel();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return source.token;
}

/**
 * Stable key for indexing permission rules. Per the contract, the
 * `__allow_always` / `__deny_always` sentinel picks must produce a
 * rule that matches FUTURE calls for the same tool — so the key
 * must be stable across requests. `toolCallId` is per-request unique
 * and would break "Always" if used as a fallback (Codacy MEDIUM
 * finding). We require `title` (the natural human-readable tool
 * name) and fall back to `kind`; if both are missing, throw a
 * RequestError so the caller is forced to set at least one.
 */
function toolKey(req: acp.RequestPermissionRequest): string {
  const title = req.toolCall.title;
  if (title && title.length > 0) return title;
  const kind = req.toolCall.kind;
  if (kind && kind.length > 0) return kind;
  throw new RequestError(
    -32000,
    "request_permission requires toolCall.title or toolCall.kind; neither was provided",
  );
}

/**
 * Persist a sentinel-pick rule to the store. Reads existing rules
 * via `store.load(...)`, appends the new rule, and saves the merged
 * list. Uses `JSON.stringify(rawInput)` as the pattern so identical
 * inputs on later calls match (and non-identical inputs do not).
 *
 * `await` is used even though most callers (vitest with a synchronous
 * `globalState.update` mock) do not need it; per Rule 7, leaving a
 * Promise un-awaited on an RPC path is the root cause of unhandled
 * rejections, so we always await and let exceptions bubble.
 */
async function persistSentinelRule(
  store: PermissionStore,
  scope: vscode.ExtensionContext,
  tool: string,
  rawInput: unknown,
  decision: "allow" | "deny",
): Promise<void> {
  const pattern = JSON.stringify(rawInput);
  const existing = await store.load(scope);
  await store.save(scope, [
    ...existing,
    { tool, pattern, decision },
  ]);
}

/**
 * Resolve the response for a non-sentinel pick: just echo the chosen
 * request `optionId` as the response `optionId`. The bridge does not
 * rewrite these — the protocol's caller asked for that exact ID.
 */
function responseForRequestOption(
  optionId: string,
): acp.RequestPermissionResponse {
  return {
    outcome: {
      outcome: "selected",
      optionId,
    },
  };
}

/**
 * Resolve the response for a sentinel pick: rewrite to the contract's
 * bridge-decision labels and persist a rule for next time.
 */
function responseForSentinel(
  optionId: typeof ALLOW_ALWAYS | typeof DENY_ALWAYS,
): acp.RequestPermissionResponse {
  return {
    outcome: {
      outcome: "selected",
      optionId: optionId === ALLOW_ALWAYS ? ALLOW_OPTION_ID : DENY_OPTION_ID,
    },
  };
}

export function makePermissionHandlers(
  store: PermissionStore,
  scope: vscode.ExtensionContext,
): {
  requestPermission: (
    req: acp.RequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<acp.RequestPermissionResponse>;
} {
  return {
    async requestPermission(req, signal) {
      // 1. Honour an aborted signal BEFORE consulting the store or
      //    showing any UI. Per contract line 60.
      if (signal?.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }

      // 2. Consult the store. A hit short-circuits the UI.
      const tool = toolKey(req);
      const input = req.toolCall.rawInput;
      const decision = store.match(tool, input);
      if (decision === "allow") {
        return {
          outcome: { outcome: "selected", optionId: ALLOW_OPTION_ID },
        };
      }
      if (decision === "deny") {
        return {
          outcome: { outcome: "selected", optionId: DENY_OPTION_ID },
        };
      }

      // 3. Show the QuickPick. Items include request.options plus the
      //    two sentinels. The CancellationToken (third positional
      //    argument) closes the UI when the signal aborts.
      const token = abortSignalToToken(signal);
      const pick = (await vscode.window.showQuickPick(
        buildPickItems(req) as never,
        {},
        token,
      )) as PickEntry | undefined;

      if (!pick) return { outcome: { outcome: "cancelled" } };

      // 4. Sentinel picks persist a new rule + return the bridge label.
      if (pick.optionId === ALLOW_ALWAYS) {
        await persistSentinelRule(store, scope, tool, input, "allow");
        return responseForSentinel(ALLOW_ALWAYS);
      }
      if (pick.optionId === DENY_ALWAYS) {
        await persistSentinelRule(store, scope, tool, input, "deny");
        return responseForSentinel(DENY_ALWAYS);
      }

      // 5. Regular request option: echo the choice.
      return responseForRequestOption(pick.optionId);
    },
  };
}