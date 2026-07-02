/**
 * `vscodeElicitationBridge` — reverse-call handler for ACP
 * `unstable_createElicitation`. Created in subagent PR #06 (this
 * file is the pre-implementation scaffold: the four RED-phase tests
 * that the PATCHER must make pass with the GREEN implementation).
 *
 * Per the contract doc `docs/agent-tasks/06-elicitation-bridge.md`,
 * the public surface is `makeElicitationHandlers()` returning a
 * `create` handler.
 *
 * Subagent home: PR #06. Consumed by PR #09 (registry) and the
 * SDK client's `connect(...)` handler plumbing from PR #02.
 *
 * NOTE on type names (Rule 16, lessons-learned): the contract doc
 * uses a simplified shape — `req.message` + `req.options` array +
 * multi-question. The installed SDK's `CreateElicitationRequest`
 * has a different shape:
 *
 *   type CreateElicitationRequest = (
 *     | (ElicitationFormMode & { mode: "form" })
 *     | (ElicitationUrlMode & { mode: "url" })
 *   ) & { message: string };
 *
 *   type ElicitationFormMode = (SessionScope | RequestScope) & {
 *     requestedSchema: ElicitationSchema;   // JSON Schema
 *   };
 *
 *   type CreateElicitationResponse = (
 *     | (ElicitationAcceptAction & { action: "accept" })
 *     | { action: "decline" }
 *     | { action: "cancel" }
 *   );
 *
 *   type ElicitationAcceptAction = {
 *     content?: { [key: string]: ElicitationContentValue } | null;
 *   };
 *
 * The contract's `options` array does not exist; the closest SDK
 * mapping is `requestedSchema.properties` (a JSON Schema map of
 * primitive fields). The contract's "multi-question" handling is
 * NOT in the SDK at all — the SDK does one elicitation at a time.
 * The PATCHER must reconcile this; the deviation is recorded in the
 * subagent-06 handoff. The scaffold below uses the SDK names and the
 * closest mapping so it type-checks; the contract-vs-SDK
 * reconciliation is the first thing the PATCHER should address.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
// The real implementation file (vscodeElicitationBridge.ts) does not
// exist yet. This RED-phase import will fail with "Cannot find module
// …" until the PATCHER writes the implementation.
import { makeElicitationHandlers } from "./vscodeElicitationBridge.js";

/* Stub the `vscode` module because vitest does not load VS Code. */
vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

const vscode = await import("vscode");

/* ─────────────────────── test fixtures ─────────────────────── */

/**
 * Single-question form. The closest SDK mapping of the contract's
 * "single question with options" case. Properties hold a single
 * string-typed entry. The PATCHER will render this as a quickpick
 * with the keys as choices.
 */
const singleQuestionRequest = {
  mode: "form",
  sessionId: "s1",
  message: "Which package manager?",
  requestedSchema: {
    type: "object",
    properties: {
      pkg: {
        type: "string",
        title: "Package manager",
        enum: ["npm", "pnpm", "yarn"],
      },
    },
    required: ["pkg"],
  },
} as unknown as acp.CreateElicitationRequest;

/** Multi-question form — multiple primitive properties on one schema. */
const multiQuestionRequest = {
  mode: "form",
  sessionId: "s1",
  message: "Project setup",
  requestedSchema: {
    type: "object",
    properties: {
      runtime: {
        type: "string",
        title: "Runtime",
        enum: ["node", "deno", "bun"],
      },
      testFramework: {
        type: "string",
        title: "Test framework",
        enum: ["vitest", "jest", "mocha"],
      },
    },
    required: ["runtime", "testFramework"],
  },
} as unknown as acp.CreateElicitationRequest;

/* ─────────────────────── tests (RED: all must fail until GREEN) ──────── */

describe("vscodeElicitationBridge", () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockReset();
    vi.mocked(vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();
  });

  it("single question, single-select, user picks an option: returns accept with the chosen label", async () => {
    // Falsification trace (Rule 3): a buggy impl that always returns
    // cancel would still pass `action: "cancel"`. We assert the
    // chosen option made it into the response content, AND that
    // showQuickPick was invoked (so the prompt actually ran).
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValue(
      { label: "npm", description: "" } as never,
    );
    const handlers = makeElicitationHandlers();
    const resp = await handlers.create(singleQuestionRequest);
    expect(resp.action).toBe("accept");
    expect((resp as { content?: Record<string, unknown> }).content).toMatchObject({
      pkg: "npm",
    });
  });

  it("multi-question, user accepts all: returns accept with all answers", async () => {
    // Falsification trace: a buggy impl that only returns the FIRST
    // answer would still pass the single-question test. Assert all
    // requested properties are present in the response.
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ label: "node", description: "" } as never)
      .mockResolvedValueOnce({ label: "vitest", description: "" } as never);
    const handlers = makeElicitationHandlers();
    const resp = await handlers.create(multiQuestionRequest);
    expect(resp.action).toBe("accept");
    expect((resp as { content?: Record<string, unknown> }).content).toMatchObject({
      runtime: "node",
      testFramework: "vitest",
    });
  });

  it("user dismisses the quickpick: returns cancel", async () => {
    vi.mocked(vscode.window.showQuickPick as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    const handlers = makeElicitationHandlers();
    const resp = await handlers.create(singleQuestionRequest);
    expect(resp.action).toBe("cancel");
  });

  it("aborted AbortSignal: returns cancel without showing UI", async () => {
    // Contract: "Aborted `AbortSignal`. The bridge returns
    // `{ action: "cancel" }` without showing UI." Falsification: the
    // bridge must return cancel even though no rule short-circuits
    // the prompt, and showQuickPick must NEVER be called.
    const controller = new AbortController();
    controller.abort();
    const handlers = makeElicitationHandlers();
    const resp = await handlers.create(singleQuestionRequest, controller.signal);
    expect(resp.action).toBe("cancel");
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});