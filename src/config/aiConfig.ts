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
};

// --- Developer Experience & Security Warnings ---

// 1. Warn if keys are missing during development for a better DX.
if (import.meta.env.DEV) {
  if (!AI_CONFIG.gemini && !AI_CONFIG.chatgpt) {
    console.warn(
      "[AI_CONFIG] No AI provider keys found in .env file. " +
        "AI-based prediction features will be disabled. " +
        "Please copy .env.example to .env.local and add your keys.",
    );
  }
}

// 2. Add a build-time warning for production builds to remind about security.
if (import.meta.env.PROD && (AI_CONFIG.gemini || AI_CONFIG.chatgpt)) {
  console.warn(
    "%c[SECURITY WARNING]",
    "color: yellow; background: red; font-size: 14px; font-weight: bold;",
    "AI API keys are bundled directly into the production build. This is a security risk. For a public extension, keys should be managed via a backend proxy or user-provided storage.",
  );
}
