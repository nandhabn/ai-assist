// src/utils/aiProviderFactory.ts

import { AIProvider } from "../types/ai";
import { GeminiProvider } from "./geminiProvider";
import { BatchingAIProvider, createBatchingProvider } from "./batchingProvider";
import type { BatchingProviderOptions } from "./batchingProvider";

const providerRegistry: Record<
  string,
  (apiKey: string, model?: string) => AIProvider
> = {
  gemini: (apiKey, model) => new GeminiProvider(apiKey, model),
};

/**
 * Factory function to create an instance of an AI provider.
 *
 * @param providerName The name of the provider to instantiate (e.g., 'gemini').
 * @param apiKey The API key for the selected provider.
 * @returns An instance of a class that implements the `AIProvider` interface.
 * @throws If the provider name is not found in the registry.
 */
export function createAIProvider(
  providerName: string,
  apiKey: string,
  model?: string,
): AIProvider {
  const providerFactory = providerRegistry[providerName];
  if (!providerFactory) {
    throw new Error(`AI provider "${providerName}" is not registered.`);
  }
  return providerFactory(apiKey, model);
}

/**
 * Creates a BatchingAIProvider backed by Gemini.
 *
 * Requests that arrive within `flushWindowMs` (default 80 ms) are merged into
 * a single Gemini API call, dramatically reducing quota consumption when the
 * agent fires several predictions in parallel.
 *
 * @example
 * const provider = createBatchingAIProvider(apiKey);
 * // All three predictNextAction calls below share ONE Gemini request:
 * const [a, b, c] = await Promise.all([
 *   provider.predictNextAction(ctxA),
 *   provider.predictNextAction(ctxB),
 *   provider.predictNextAction(ctxC),
 * ]);
 */
export function createBatchingAIProvider(
  apiKey: string,
  options?: BatchingProviderOptions,
): BatchingAIProvider {
  return createBatchingProvider(apiKey, options);
}

export { BatchingAIProvider };
export type { BatchingProviderOptions };
