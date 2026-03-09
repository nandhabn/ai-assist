/**
 * Lazily initializes and returns the AI provider chain.
 * Builds a QueuedAIProvider so requests are serialised and providers
 * fail over automatically when a 429 / quota error is returned.
 */

import { createAIProvider, createNovaProvider } from "@/utils/aiProviderFactory";
import { buildQueuedProvider, QueuedAIProvider } from "@/utils/aiQueue";
import { AI_CONFIG } from "@/config/aiConfig";

export function getAIProvider(): QueuedAIProvider | null {
  const chain: ReturnType<typeof createAIProvider>[] = [];

  // Priority order: ChatGPT API → Nova → Gemini → ChatGPT Tab (only if enabled)
  if (AI_CONFIG.chatgpt) {
    try { chain.push(createAIProvider("chatgpt", AI_CONFIG.chatgpt)); }
    catch (e) { console.error("Failed to init ChatGPT:", e); }
  }
  if (AI_CONFIG.novaConfig) {
    try { chain.push(createNovaProvider(AI_CONFIG.novaConfig)); }
    catch (e) { console.error("Failed to init Amazon Nova:", e); }
  }
  if (AI_CONFIG.gemini) {
    try { chain.push(createAIProvider("gemini", AI_CONFIG.gemini)); }
    catch (e) { console.error("Failed to init Gemini:", e); }
  }
  if (AI_CONFIG.chatgptTab) {
    try { chain.push(createAIProvider("chatgpt-tab", "")); }
    catch (e) { console.warn("ChatGPT Tab unavailable:", e); }
  }

  if (chain.length === 0) return null;
  return buildQueuedProvider(chain);
}
