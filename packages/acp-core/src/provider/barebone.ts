/**
 * AcpBareboneProvider — the minimum compileable `vscode.LanguageModelChatProvider`
 * that ships with the barebone foundation. Returns 0 models; the full registry
 * lands in subagent PR 09 (`docs/agent-tasks/09-registry.md`).
 *
 * Naming: `AcpBareboneProvider` is the barebone implementation. PR 09 will
 * add `AcpModelProvider` (the real registry) and `extension.ts` will switch
 * to it. Keeping the two names distinct avoids accidental import drift.
 */

import type * as vscode from "vscode";

/**
 * Structural alias for the bits of `vscode.LanguageModelTextPart` we read.
 * Using a structural shape (not `instanceof`) keeps the barebone testable
 * without the real `vscode` module loaded.
 */
interface TextPartLike { readonly value: string }

function isTextPartLike(p: unknown): p is TextPartLike {
  return typeof p === "object" && p !== null && "value" in p && typeof (p as { value: unknown }).value === "string";
}

export class AcpBareboneProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    // Barebone: nothing to advertise. PR 09 wires this to
    // `SessionPool.listModels()` and the discovery layer.
    return [];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    throw new Error(
      "AcpBareboneProvider is in barebone mode: no model was registered, so the model " +
        "picker should not have offered this entry. If you see this error, " +
        "the picker is showing stale data — reload the window.",
    );
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    // Rough heuristic: ~4 chars per token. Good enough until a real tokenizer
    // arrives. PR 11 (docs/agent-tasks/11-ci-docs.md) will swap this for
    // tiktoken or a model-side `count_tokens` if it becomes user-visible.
    if (typeof text === "string") {
      return Promise.resolve(Math.ceil(text.length / 4));
    }
    let total = 0;
    for (const part of text.content) {
      if (typeof part === "string") {
        total += part.length;
      } else if (isTextPartLike(part)) {
        total += part.value.length;
      }
      // Other content kinds (images, tool calls, tool results) are not
      // counted in this heuristic. PR 09 will route them properly.
    }
    return Promise.resolve(Math.ceil(total / 4));
  }
}