// src/utils/aiProviderFactory.ts

import { AIProvider } from '../types/ai';
import { GeminiProvider } from './geminiProvider';

/**
 * A registry of available AI provider implementations.
 * This pattern allows for the dynamic selection of a provider based on configuration,
 * making the system provider-agnostic.
 *
 * @Architectural-Note To add a new provider (e.g., 'NovaProvider'), you would:
 * 1. Implement the `AIProvider` interface in a new file (e.g., `novaProvider.ts`).
 * 2. Import it here.
 * 3. Add a new entry to the `providerRegistry`, like:
 *    `nova: (apiKey) => new NovaProvider(apiKey)`
 * The rest of the application can then select 'nova' via configuration without
 * needing any other code changes.
 */
const providerRegistry: Record<string, (apiKey: string) => AIProvider> = {
  gemini: (apiKey) => new GeminiProvider(apiKey),
  // nova: (apiKey) => new NovaProvider(apiKey), // Example for a future provider
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
  apiKey: string
): AIProvider {
  const providerFactory = providerRegistry[providerName];
  if (!providerFactory) {
    throw new Error(`AI provider "${providerName}" is not registered.`);
  }
  return providerFactory(apiKey);
}
