// src/utils/aiProviderFactory.ts

import { AIProvider } from "../types/ai";
import { GeminiProvider } from "./geminiProvider";
import { ChatGPTProvider } from "./chatgptProvider";
import { ChatGPTTabProvider } from "./chatgptTabProvider";
import { NovaProvider, NovaConfig } from "./novaProvider";

const providerRegistry: Record<string, (apiKey: string) => AIProvider> = {
  gemini: (apiKey) => new GeminiProvider(apiKey),
  chatgpt: (apiKey) => new ChatGPTProvider(apiKey),
  "chatgpt-tab": (_apiKey) => new ChatGPTTabProvider(),
};

/**
 * Factory function to create an instance of an AI provider.
 *
 * @param providerName The name of the provider to instantiate (e.g., 'gemini').
 * @param apiKey The API key for the selected provider. Pass empty string for 'nova' — use createNovaProvider() instead.
 * @returns An instance of a class that implements the `AIProvider` interface.
 * @throws If the provider name is not found in the registry.
 */
export function createAIProvider(
  providerName: string,
  apiKey: string,
): AIProvider {
  const providerFactory = providerRegistry[providerName];
  if (!providerFactory) {
    throw new Error(`AI provider "${providerName}" is not registered.`);
  }
  return providerFactory(apiKey);
}

/** Creates a NovaProvider from a structured config object. */
export function createNovaProvider(config: NovaConfig): NovaProvider {
  return new NovaProvider(config);
}
