// src/config/aiConfig.ts

/**
 * @Architectural-Note Keys are loaded at runtime from chrome.storage.local
 * (user-provided via the Settings panel), with build-time .env vars as fallback
 * for local development. Use `getAIConfig()` for runtime key resolution.
 *
 * @Security-Note Keys are stored in chrome.storage.local — sandboxed to the
 * extension and never embedded in the bundle.
 */

import { getUserKeys, type ProviderName } from "@/utils/storage";

export type { ProviderName };

/** Build-time fallback config (used during local development via .env). */
export const AI_CONFIG = {
  gemini: import.meta.env.VITE_GEMINI_API_KEY,
};

export interface ResolvedAIConfig {
  gemini?: string;
  preferredProvider?: ProviderName;
  preferredModel?: string;
}

/**
 * Runtime config that merges user-stored keys (from Settings panel) over
 * build-time env vars. User keys always win.
 */
export async function getAIConfig(): Promise<ResolvedAIConfig> {
  const userKeys = await getUserKeys();

  return {
    gemini: userKeys.gemini || AI_CONFIG.gemini,
    preferredProvider: userKeys.preferredProvider,
    preferredModel: userKeys.preferredModel,
  };
}

// --- Developer Experience & Security Warnings ---

if (import.meta.env.DEV) {
  if (!AI_CONFIG.gemini) {
    console.warn(
      "[AI_CONFIG] No Gemini API key found in .env file. " +
        "Users can provide a key via the Settings panel in the popup.",
    );
  }
}
