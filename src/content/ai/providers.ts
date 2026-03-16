/**
 * Lazily initializes and returns the AI provider chain.
 * Builds a QueuedAIProvider so requests are serialised and providers
 * fail over automatically when a 429 / quota error is returned.
 */

import {
  createAIProvider,
  createNovaProvider,
} from "@/utils/aiProviderFactory";
import { buildQueuedProvider, QueuedAIProvider } from "@/utils/aiQueue";
import { getAIConfig } from "@/config/aiConfig";
import type { ProviderName } from "@/utils/storage";

// Invalidate the cached provider whenever the user saves new settings in the popup.
// This ensures the next prediction picks up the updated model / provider / API key.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "flowRecorder_userKeys" in changes) {
    import("../state").then(({ state }) => {
      state.aiProvider = undefined;
      console.log(
        "[providers] Settings changed — AI provider will be re-initialized on next use.",
      );
    });
  }
});

type ProviderEntry = {
  name: ProviderName;
  factory: () => ReturnType<typeof createAIProvider> | null;
};

export async function getAIProvider(): Promise<QueuedAIProvider | null> {
  const config = await getAIConfig();

  const allProviders: ProviderEntry[] = [
    {
      name: "gemini",
      factory: () =>
        config.gemini
          ? createAIProvider(
              "gemini",
              config.gemini,
              config.preferredProvider === "gemini"
                ? config.preferredModel
                : undefined,
            )
          : null,
    },
    {
      name: "chatgpt",
      factory: () =>
        config.chatgpt
          ? createAIProvider(
              "chatgpt",
              config.chatgpt,
              config.preferredProvider === "chatgpt"
                ? config.preferredModel
                : undefined,
            )
          : null,
    },
    {
      name: "nova",
      factory: () =>
        config.novaConfig ? createNovaProvider(config.novaConfig) : null,
    },
  ];

  // Move preferred provider to front of chain
  const preferred = config.preferredProvider;
  const ordered = preferred
    ? [
        ...allProviders.filter((p) => p.name === preferred),
        ...allProviders.filter((p) => p.name !== preferred),
      ]
    : allProviders;

  const chain: ReturnType<typeof createAIProvider>[] = [];
  for (const { name, factory } of ordered) {
    try {
      const provider = factory();
      if (provider) chain.push(provider);
    } catch (e) {
      console.error(`Failed to init provider "${name}":`, e);
    }
  }

  if (chain.length === 0) return null;
  return buildQueuedProvider(chain);
}
