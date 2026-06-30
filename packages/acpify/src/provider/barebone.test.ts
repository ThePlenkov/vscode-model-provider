/**
 * Barebone smoke test for `@theplenkov/acpify`.
 *
 * Purpose: give the build CI a single Vitest that fails if the package does
 * not compile, the provider class is missing, or the import paths in
 * `extension.ts` are wrong. Real behaviour tests land with each subagent PR
 * (see docs/agent-tasks/*).
 */

import { describe, it, expect } from "vitest";
import { AcpBareboneProvider } from "./barebone.js";

describe("AcpBareboneProvider", () => {
  it("exports a class", () => {
    expect(AcpBareboneProvider).toBeDefined();
  });

  it("exposes no models when no agent is configured", () => {
    const p = new AcpBareboneProvider();
    // Cancellation token is optional for the barebone; pass `undefined as never`
    // because the barebone does not read it.
    const result = p.provideLanguageModelChatInformation(
      { silent: true } as never,
      undefined as never,
    );
    // ProviderResult<T> = T | Thenable<T> | undefined; we returned []
    // synchronously, so `result` is `unknown[]`.
    expect(result).toEqual([]);
  });

  it("throws if a caller actually invokes a response (the barebone is not wired)", async () => {
    const p = new AcpBareboneProvider();
    await expect(
      p.provideLanguageModelChatResponse(
        {} as never,
        [],
        {} as never,
        { report: () => undefined } as never,
        undefined as never,
      ),
    ).rejects.toThrow(/barebone mode/);
  });

  it("estimates token count as ~length/4", async () => {
    const p = new AcpBareboneProvider();
    const n = await p.provideTokenCount({} as never, "hello world", undefined as never);
    expect(n).toBe(3); // "hello world" is 11 chars, ceil(11/4) = 3
  });
});