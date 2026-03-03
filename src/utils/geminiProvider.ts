// src/utils/geminiProvider.ts

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  FormFieldInfo,
  AIFormData,
} from "../types/ai";
import {
  buildPredictionPrompt,
  buildFormDataPrompt,
  formatFieldDescriptions,
} from "@/config/prompts";

function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

// ─── Gemini call counter (persists for the lifetime of the content script) ────
const geminiStats = { total: 0, success: 0, error: 0 };

function geminiStatsLabel() {
  return `calls=${geminiStats.total} ok=${geminiStats.success} err=${geminiStats.error}`;
}

/** Returns a snapshot of Gemini API call counts for this page session. */
export function getGeminiCallStats() {
  return { ...geminiStats };
}

/** Resets all Gemini call counters to zero. */
export function resetGeminiCallStats() {
  geminiStats.total = 0;
  geminiStats.success = 0;
  geminiStats.error = 0;
}

const GEMINI_API_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

/**
 * An AIProvider implementation that uses Google's Gemini Pro model.
 *
 * @Architectural-Note This class is designed to work within a Chrome Extension's
 * background service worker. It uses the `fetch` API, which is available in this context.
 * It is a self-contained module with no external dependencies besides the types.
 *
 * @Security-Note The API key is a sensitive credential. It should be provided by the
 * user through an options page and stored securely in `chrome.storage.local` or
 * `chrome.storage.sync`. It must NOT be hardcoded in the source code.
 * The use of a backend proxy to manage API keys is the most secure long-term solution.
 */
export class GeminiProvider implements AIProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("GeminiProvider requires an API key.");
    }
    this.apiKey = apiKey;
  }

  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    geminiStats.total++;
    aiLog(
      `[Gemini] predictNextAction START | Intent: ${context.pageIntent} | Actions: ${context.topVisibleActions.length} | Fields: ${context.formFields.length} | ${geminiStatsLabel()}`,
    );

    const prompt = buildPredictionPrompt(context);

    try {
      const response = await fetch(
        GEMINI_API_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: "application/json",
              temperature: 0.2,
              maxOutputTokens: 2048,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        aiLog(`[Gemini] predictNextAction FAILED | Status: ${response.status}`);
        console.error("Gemini API request failed:", response.status, errorBody);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();
      const predictionText = data.candidates[0].content.parts[0].text;
      const prediction = JSON.parse(predictionText) as AIPrediction;

      // Basic validation of the response
      if (
        !prediction.predictedActionLabel ||
        !prediction.reasoning ||
        typeof prediction.confidenceEstimate !== "number"
      ) {
        throw new Error("Invalid JSON structure from Gemini API.");
      }

      geminiStats.success++;
      return prediction;
    } catch (error) {
      geminiStats.error++;
      aiLog(`[Gemini] predictNextAction ERROR | ${error} | ${geminiStatsLabel()}`);
      console.error("Error in GeminiProvider:", error);
      throw new Error("Failed to get prediction from Gemini.");
    }
  }

  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    geminiStats.total++;
    aiLog(
      `[Gemini] generateFormData START | Fields: ${fields.length} | Context: ${pageContext || "none"} | ${geminiStatsLabel()}`,
    );
    const fieldDescriptions = formatFieldDescriptions(fields);
    const prompt = buildFormDataPrompt(fieldDescriptions, pageContext);

    try {
      const response = await fetch(
        GEMINI_API_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: "application/json",
              temperature: 0.7,
              maxOutputTokens: 2048,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        aiLog(`[Gemini] generateFormData FAILED | Status: ${response.status}`);
        console.error(
          "Gemini API form data request failed:",
          response.status,
          errorBody,
        );
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();
      const resultText = data.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(resultText) as AIFormData;

      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure from Gemini API.");
      }

      aiLog(
        `[Gemini] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(", ")} | ${geminiStatsLabel()}`,
      );
      geminiStats.success++;
      return parsed;
    } catch (error) {
      geminiStats.error++;
      aiLog(`[Gemini] generateFormData ERROR | ${error} | ${geminiStatsLabel()}`);
      console.error("Error generating form data with Gemini:", error);
      throw new Error("Failed to generate form data from Gemini.");
    }
  }

  /** Returns a snapshot of the Gemini API call statistics for this session. */
  static getCallStats(): { total: number; success: number; error: number } {
    return { ...geminiStats };
  }
}
