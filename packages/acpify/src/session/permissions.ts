/**
 * PermissionStore — in-memory rule list for `session/request_permission`
 * answers. Lives in `packages/acpify/src/session/` because every consumer
 * of the pool needs it: the capability bridge (PR 05) reads rules to
 * auto-answer, the provider (PR 09) exposes a command to edit them, and
 * the extension (PR 02 wiring) loads/saves them.
 *
 * Storage model: a list of `{ tool, pattern?, decision }` rules. `match`
 * returns the first matching rule's decision, or `undefined` if none
 * match. Persistence is delegated to `vscode.ExtensionContext.globalState`
 * if a context is provided; otherwise the store is purely in-memory for
 * the session and the `load`/`save` calls are no-ops.
 *
 * Per the architecture decision in `docs/architecture.md` §`vscode`
 * imports, this module is allowed to use `vscode` types only — never
 * the runtime — so it stays testable from Vitest without the VS Code
 * host.
 */

import type * as vscode from "vscode";

export interface PermissionRule {
  /** ACP `tool_call.title` or `tool_call.kind` this rule applies to. */
  readonly tool: string;
  /**
   * Optional pattern matched against the tool's input (JSON-stringified,
   * then substring- or regex-matched). `undefined` means "any input".
   */
  readonly pattern?: string;
  readonly decision: "allow" | "deny";
}

export type PermissionDecision = "allow" | "deny" | undefined;

/**
 * Keys used to persist rules in `ExtensionContext.globalState`.
 *
 * Versioned so a future migration can read the previous shape and
 * upgrade in place.
 */
const STORAGE_KEY = "acpify.permissions.v1";

export class PermissionStore {
  private rules: PermissionRule[] = [];

  /** Replace the in-memory rule list with rules from `scope.globalState`. */
  async load(scope: vscode.ExtensionContext): Promise<PermissionRule[]> {
    const raw = scope.globalState.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(raw)) {
      this.rules = [];
      return this.rules;
    }
    this.rules = raw.filter(isPermissionRule);
    return this.rules;
  }

  /** Persist the current rule list to `scope.globalState`. */
  async save(scope: vscode.ExtensionContext, rules: PermissionRule[]): Promise<void> {
    this.rules = rules.slice();
    await scope.globalState.update(STORAGE_KEY, this.rules);
  }

  /**
   * Test whether `tool` (with `input`) matches any rule. Returns the
   * first matching rule's decision. `pattern`, if present, is matched as
   * a substring against `JSON.stringify(input)` so callers do not have
   * to know the tool's input schema.
   */
  match(tool: string, input: unknown): PermissionDecision {
    for (const rule of this.rules) {
      if (rule.tool !== tool) continue;
      if (rule.pattern === undefined) return rule.decision;
      const haystack = safeStringify(input);
      if (haystack.includes(rule.pattern)) return rule.decision;
    }
    return undefined;
  }
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["tool"] !== "string") return false;
  if (v["decision"] !== "allow" && v["decision"] !== "deny") return false;
  if (v["pattern"] !== undefined && typeof v["pattern"] !== "string") return false;
  return true;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}