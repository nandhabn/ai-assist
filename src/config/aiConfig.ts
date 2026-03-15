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
  chatgpt: import.meta.env.VITE_OPENAI_API_KEY,
  /**
   * Amazon Bedrock / Nova credentials.
   * Prefer the individual vars (VITE_AWS_ACCESS_KEY etc.).
   * Falls back to the legacy colon-separated VITE_AWS_BEDROCK_CREDENTIALS string.
   */
  novaConfig: (() => {
    const accessKey = import.meta.env.VITE_AWS_ACCESS_KEY;
    const secretKey = import.meta.env.VITE_AWS_SECRET_KEY;
    const region    = import.meta.env.VITE_AWS_REGION    || "us-east-1";
    const apiKey    = import.meta.env.VITE_AWS_BEDROCK_API_KEY;
    const model     = import.meta.env.VITE_AWS_NOVA_MODEL || "global.amazon.nova-2-lite-v1:0";
    const legacy    = import.meta.env.VITE_AWS_BEDROCK_CREDENTIALS;

    // Individual vars take priority
    if (accessKey && secretKey) {
      return { accessKey, secretKey, region, model, bedrockApiKey: apiKey };
    }
    // Fall back to legacy colon-separated string
    if (legacy) {
      const parts = legacy.split(":");
      return {
        accessKey:    parts[0],
        secretKey:    parts[1],
        region:       (parts.length >= 3 && parts[2].includes("-")) ? parts[2] : (parts[3] || "us-east-1"),
        bedrockApiKey: undefined as string | undefined,
      };
    }
    return null;
  })(),
  /** Set true to use the open ChatGPT tab as a provider */
  chatgptTab: false,
};

// Convenience alias used in provider-presence checks
(AI_CONFIG as any).nova = AI_CONFIG.novaConfig;

export interface ResolvedAIConfig {
  gemini?: string;
  chatgpt?: string;
  novaConfig: typeof AI_CONFIG.novaConfig;
  chatgptTab: boolean;
  preferredProvider?: ProviderName;
  preferredModel?: string;
}

/**
 * Runtime config that merges user-stored keys (from Settings panel) over
 * build-time env vars. User keys always win.
 */
export async function getAIConfig(): Promise<ResolvedAIConfig> {
  const userKeys = await getUserKeys();

  const novaConfig = (() => {
    if (userKeys.awsAccessKey && userKeys.awsSecretKey) {
      return {
        accessKey:     userKeys.awsAccessKey,
        secretKey:     userKeys.awsSecretKey,
        region:        userKeys.awsRegion || "us-east-1",
        model:         userKeys.preferredProvider === "nova" && userKeys.preferredModel
                         ? userKeys.preferredModel
                         : "global.amazon.nova-2-lite-v1:0",
        bedrockApiKey: undefined as string | undefined,
      };
    }
    return AI_CONFIG.novaConfig;
  })();

  return {
    gemini:            userKeys.gemini  || AI_CONFIG.gemini,
    chatgpt:           userKeys.openai  || AI_CONFIG.chatgpt,
    novaConfig,
    // Enable chatgpt-tab if the user explicitly selected it as their preferred
    // provider, even when the build-time flag is off.
    chatgptTab:        AI_CONFIG.chatgptTab || userKeys.preferredProvider === "chatgpt-tab",
    preferredProvider: userKeys.preferredProvider,
    preferredModel:    userKeys.preferredModel,
  };
}

// --- Developer Experience & Security Warnings ---

if (import.meta.env.DEV) {
  const hasNova = !!AI_CONFIG.novaConfig;
  if (!AI_CONFIG.gemini && !AI_CONFIG.chatgpt && !hasNova) {
    console.warn(
      "[AI_CONFIG] No AI provider keys found in .env file. " +
        "Users can provide keys via the Settings panel in the popup.",
    );
  }
}
