// src/config/aiConfig.ts

/**
 * @Architectural-Note This module centralizes the access to environment variables
 * related to AI providers. It leverages Vite's `import.meta.env` feature to load
 * keys from a `.env` file at build time, with types defined in `vite-env.d.ts`.
 *
 * @Security-Note While using .env files is better than hardcoding, these keys are
 * still embedded in the compiled content script. For a production extension, the
 * most secure pattern is for the user to enter their key in the extension's options
 * page, where it is stored in `chrome.storage.local`.
 */

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
    const model     = import.meta.env.VITE_AWS_NOVA_MODEL || "amazon.nova-lite-v2:0";
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
// (keep existing callers like `if (AI_CONFIG.nova)` working)
(AI_CONFIG as any).nova = AI_CONFIG.novaConfig;

// --- Developer Experience & Security Warnings ---

// 1. Warn if keys are missing during development for a better DX.
if (import.meta.env.DEV) {
  const hasNova = !!AI_CONFIG.novaConfig;
  if (!AI_CONFIG.gemini && !AI_CONFIG.chatgpt && !hasNova) {
    console.warn(
      "[AI_CONFIG] No AI provider keys found in .env file. " +
        "AI-based prediction features will be disabled. " +
        "Please copy .env.example to .env.local and add your keys.",
    );
  }
}

// 2. Add a build-time warning for production builds to remind about security.
if (import.meta.env.PROD && (AI_CONFIG.gemini || AI_CONFIG.chatgpt || AI_CONFIG.novaConfig)) {
  console.warn(
    "%c[SECURITY WARNING]",
    "color: yellow; background: red; font-size: 14px; font-weight: bold;",
    "AI API keys are bundled directly into the production build. This is a security risk. For a public extension, keys should be managed via a backend proxy or user-provided storage.",
  );
}
