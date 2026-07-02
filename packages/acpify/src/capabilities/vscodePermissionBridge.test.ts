/**
 * `vscodePermissionBridge` — reverse-call handler for ACP
 * `session/request_permission`. Created in subagent PR #05.
 *
 * Per the contract doc `docs/agent-tasks/05-permission-bridge.md`,
 * the public surface is `makePermissionHandlers(store, scope)`
 * returning a `requestPermission` handler that:
 *
 *   1. Consults `store.match(tool, input)` first; on a hit, returns
 *      the matching decision without showing a UI prompt.
 *   2. Otherwise, calls `vscode.window.showQuickPick` with the
 *      request's `options` plus two sentinel entries (`__allow_always`,
 *      `__deny_always`). On a pick, the bridge may add a new
 *      `PermissionRule` to the store and return the chosen option.
 *   3. On cancel: returns `{ outcome: { outcome: "cancelled" } }`.
 *   4. Honours an aborted `AbortSignal` by returning `cancelled`
 *      without showing a UI prompt.
 *
 * Subagent home: PR #05. Consumed by PR #09 (registry) and the SDK
 * client's `connect(...)` handler plumbing from PR #02.
 *
 * NOTE on type names: the contract doc uses
 * `acp.RequestPermissionRequest` / `acp.RequestPermissionResponse`.
 * The installed SDK exports exactly these names (verified by the
 * next agent before scaffolding this file). Per Rule 16
 * (lessons-learned), sanity-checked against the SDK.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type * as vscodeTypes from "vscode";
import { makePermissionHandlers } from "./vscodePermissionBridge.js";
import { PermissionStore } from "../session/permissions.js";

/* Stub the `vscode` module because vitest does not load VS Code. */
vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));

const vscode = await import("vscode");

/* ─────────────────────── test fixtures ─────────────────────── */

/** A minimal `vscode.ExtensionContext` for the bridge to load/save rules. */
function fakeContext(): vscodeTypes.ExtensionContext {
  return {
    globalState: {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => []),
    },
  } as unknown as vscodeTypes.ExtensionContext;
}

const sampleRequest = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "tc-1",
    title: "execute_command",
    kind: "execute",
    rawInput: { command: "rm -rf /tmp/important" },
  },
  options: [
    {
      optionId: "allow-once",
      name: "Allow once",
      kind: "allow_once",
    },
    {
      optionId: "reject-once",
      name: "Reject once",
      kind: "reject_once",
    },
  ],
} as unknown as acp.RequestPermissionRequest;

/* ─────────────────────── tests ─────────────────────── */

describe("vscodePermissionBridge", () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockReset();
  });

  it("allow: short-circuits when the store returns 'allow' and never shows UI", async () => {
    // Falsification trace (Rule 3): a buggy impl that always shows
    // the quickpick and asks the user would still resolve to "allow"
    // if the user picks it. To prove the store path is exercised,
    // assert showQuickPick was NEVER called.
    //
    // The response `optionId: "allow"` is the bridge's mapping from
    // the store decision ("allow" → optionId "allow"). It is NOT
    // pulled from `sampleRequest.options` — that array is irrelevant
    // when the store short-circuits.
    const store = new PermissionStore();
    store.save(fakeContext(), [
      { tool: "execute_command", decision: "allow" },
    ]);
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest);
    expect(resp.outcome).toMatchObject({
      outcome: "selected",
      optionId: "allow",
    });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("deny: short-circuits when the store returns 'deny' and never shows UI", async () => {
    // As above: the response `optionId: "deny"` is the bridge's
    // decision→optionId mapping, not pulled from the request's options.
    const store = new PermissionStore();
    store.save(fakeContext(), [
      { tool: "execute_command", decision: "deny" },
    ]);
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest);
    expect(resp.outcome).toMatchObject({
      outcome: "selected",
      optionId: "deny",
    });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it("no rule, user picks '__allow_always': store gains a rule and response is allow", async () => {
    // Falsification trace (Rule 3): the bridge must (a) add a new
    // PermissionRule to the store on the sentinel pick, and (b) the
    // store.match path must be exercised on a subsequent call. Both
    // are asserted below.
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValue(
      { optionId: "__allow_always", label: "Allow always" } as never,
    );
    const store = new PermissionStore();
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest);
    expect(resp.outcome).toMatchObject({
      outcome: "selected",
      optionId: "allow",
    });
    expect(store.match("execute_command", { command: "rm -rf /tmp/important" })).toBe("allow");
  });

  it("no rule, user picks '__deny_always': store gains a deny rule and response is deny", async () => {
    // The contract requires both `__allow_always` and `__deny_always`
    // sentinels (contract line 59). Symmetric to the allow-always case.
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValue(
      { optionId: "__deny_always", label: "Deny always" } as never,
    );
    const store = new PermissionStore();
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest);
    expect(resp.outcome).toMatchObject({
      outcome: "selected",
      optionId: "deny",
    });
    expect(store.match("execute_command", { command: "rm -rf /tmp/important" })).toBe("deny");
  });

  it("no rule, user cancels: returns cancelled and adds no rule", async () => {
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    const store = new PermissionStore();
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest);
    expect(resp.outcome).toMatchObject({ outcome: "cancelled" });
    expect(store.match("execute_command", { command: "rm -rf /tmp/important" })).toBeUndefined();
  });

  it("aborted signal: returns cancelled and never shows UI", async () => {
    // Contract line 60: "The bridge honours an aborted `AbortSignal`
    // by returning `{ outcome: { outcome: "cancelled" } }` and **not**
    // showing the quickpick." Falsification trace: assert
    // showQuickPick was NEVER called even though no rule matched.
    const controller = new AbortController();
    controller.abort();
    const store = new PermissionStore();
    const handlers = makePermissionHandlers(store, fakeContext());
    const resp = await handlers.requestPermission(sampleRequest, controller.signal);
    expect(resp.outcome).toMatchObject({ outcome: "cancelled" });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});