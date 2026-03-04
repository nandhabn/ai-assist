// src/utils/geminiProvider.ts

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  AgentToolCall,
  FormFieldInfo,
  AIFormData,
} from "../types/ai";
import {
  buildPredictionPrompt,
  buildAgentToolPrompt,
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

// ─── Safe JSON parser ─────────────────────────────────────────────────────────

/**
 * Parses a Gemini response string into T.
 * Handles two common failure modes:
 *
 * 1. Markdown code fences — Gemini sometimes wraps output in ```json ... ```
 *    even when response_mime_type is set to application/json.
 *
 * 2. Truncated strings — when maxOutputTokens is too low the last JSON string
 *    value gets cut off, leaving an unterminated string.  We attempt a repair
 *    by closing the string and all open braces/brackets before retrying.
 */
function safeJsonParse<T>(raw: string): T {
  // 1. Strip markdown code fences
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // 2. Strip any prose preamble before the first '{' or '['
  //    e.g. "Here is the JSON requested:\n{...}"
  const firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) text = text.slice(firstBrace).trim();

  // 3. Try a clean parse first
  try {
    return JSON.parse(text) as T;
  } catch (firstErr) {
    // 4. Attempt truncation repair for truncated/incomplete JSON
    const msg = (firstErr as Error).message ?? "";
    const isTruncation =
      msg.includes("Unterminated") ||
      msg.includes("Unexpected end") ||
      msg.includes("Expected property name") ||
      msg.includes("Unexpected token");
    if (!isTruncation) {
      throw firstErr;
    }

    // Close any open string, then close open braces/brackets
    let repaired = text;
    // Count unescaped quotes to determine if we're inside a string
    const quoteCount = (repaired.match(/(?<!\\)"/g) ?? []).length;
    if (quoteCount % 2 !== 0) repaired += '"';  // close open string

    // If the text ends with a bare ":" (missing value), insert null
    if (/:\s*$/.test(repaired)) repaired += "null";

    // Close any open objects/arrays (scan the stack)
    const stack: string[] = [];
    for (const ch of repaired) {
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
    repaired += stack.reverse().join("");

    try {
      const result = JSON.parse(repaired) as T;
      console.warn("[Gemini] Repaired truncated JSON successfully.");
      return result;
    } catch (repairErr) {
      // Re-throw the original error so callers see the real problem
      throw firstErr;
    }
  }
}

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

    // Trim the context to keep the prompt within a manageable token budget.
    // 20 actions with long selectors + a full plan can exhaust output tokens.
    const trimmedContext: CompactContext = {
      ...context,
      topVisibleActions: context.topVisibleActions.slice(0, 12),
      stepHistory: context.stepHistory?.slice(-5),
    };
    const prompt = buildPredictionPrompt(trimmedContext);

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
              maxOutputTokens: 4096,
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
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") {
        console.warn("[Gemini] predictNextAction: response hit MAX_TOKENS limit — increase maxOutputTokens further if truncation persists.");
      }
      if (!candidate || !candidate.content?.parts?.[0]?.text) {
        const reason = candidate?.finishReason ?? "no candidates";
        aiLog(`[Gemini] predictNextAction NO CONTENT | finishReason: ${reason}`);
        throw new Error(`Gemini returned no content (${reason})`);
      }
      const predictionText = candidate.content.parts[0].text;
      aiLog(`[Gemini] predictNextAction RAW RESPONSE:\n${predictionText}`);
      let prediction: AIPrediction;
      try {
        prediction = safeJsonParse<AIPrediction>(predictionText);
      } catch (parseErr) {
        console.error("[Gemini] predictNextAction JSON parse FAILED. Raw text:", predictionText);
        throw parseErr;
      }

      // Back-fill defaults for fields that may be absent in truncated-but-repaired
      // responses.  Only `predictedActionLabel` is truly required to take action.
      if (!("reasoning" in prediction) || !prediction.reasoning) {
        prediction.reasoning = "(truncated)";
      }
      if (!("confidenceEstimate" in prediction) || prediction.confidenceEstimate == null) {
        prediction.confidenceEstimate = 0;
      }

      // Hard-require predictedActionLabel — without it there is nothing to act on.
      if (!("predictedActionLabel" in prediction)) {
        throw new Error("Invalid JSON structure from Gemini API.");
      }
      // If the label is missing/empty due to truncation, fall through to error so the
      // agent retries rather than acting on a blank action.
      if (!prediction.predictedActionLabel) {
        throw new Error("Gemini response truncated: predictedActionLabel is empty.");
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
      const candidate = data?.candidates?.[0];
      if (!candidate || !candidate.content?.parts?.[0]?.text) {
        const reason = candidate?.finishReason ?? "no candidates";
        aiLog(`[Gemini] generateFormData NO CONTENT | finishReason: ${reason}`);
        throw new Error(`Gemini returned no content (${reason})`);
      }
      const resultText = candidate.content.parts[0].text;
      aiLog(`[Gemini] generateFormData RAW RESPONSE:\n${resultText}`);
      let parsed: AIFormData;
      try {
        parsed = safeJsonParse<AIFormData>(resultText);
      } catch (parseErr) {
        console.error("[Gemini] generateFormData JSON parse FAILED. Raw text:", resultText);
        throw parseErr;
      }

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

  /**
   * Agent tool-calling mode.
   * Sends the page context to Gemini and asks it to call one of the typed agent
   * tools (navigate / click / type / scroll / done) with explicit parameters.
   * This replaces the old label-prediction + fuzzy-match flow for agent mode.
   */
  async callAgentTool(context: CompactContext): Promise<AgentToolCall> {
    geminiStats.total++;
    aiLog(
      `[Gemini] callAgentTool START | Step: ${context.currentPlanStep ?? "?"} | Elements: ${context.pageElements?.length ?? 0} | ${geminiStatsLabel()}`,
    );

    const prompt = buildAgentToolPrompt(context);

    try {
      const response = await fetch(GEMINI_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1,
            maxOutputTokens: 1024,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        aiLog(`[Gemini] callAgentTool FAILED | Status: ${response.status}`);
        throw new Error(`Gemini API error: ${response.status} — ${errorBody}`);
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") {
        console.warn("[Gemini] callAgentTool: response hit MAX_TOKENS limit — increase maxOutputTokens further if truncation persists.");
      }
      if (!candidate || !candidate.content?.parts?.[0]?.text) {
        const reason = candidate?.finishReason ?? "no candidates";
        throw new Error(`Gemini returned no content (${reason})`);
      }

      const raw = candidate.content.parts[0].text;
      aiLog(`[Gemini] callAgentTool RAW RESPONSE:\n${raw}`);

      let toolCall: AgentToolCall;
      try {
        toolCall = safeJsonParse<AgentToolCall>(raw);
      } catch (parseErr) {
        console.error("[Gemini] callAgentTool JSON parse FAILED. Raw:", raw);
        throw parseErr;
      }

      // Validate required fields
      if (!toolCall.tool) {
        throw new Error("callAgentTool: missing 'tool' field in response");
      }
      const validTools = ["navigate", "click", "type", "scroll", "done"];
      if (!validTools.includes(toolCall.tool)) {
        throw new Error(`callAgentTool: unknown tool '${toolCall.tool}'`);
      }
      toolCall.params ??= {};
      toolCall.reasoning ??= "(no reasoning)";
      toolCall.confidenceEstimate ??= 0.5;

      aiLog(
        `[Gemini] callAgentTool SUCCESS | tool=${toolCall.tool} | ${JSON.stringify(toolCall.params)} | ${geminiStatsLabel()}`,
      );
      geminiStats.success++;
      return toolCall;
    } catch (error) {
      geminiStats.error++;
      aiLog(`[Gemini] callAgentTool ERROR | ${error} | ${geminiStatsLabel()}`);
      console.error("[GeminiProvider] callAgentTool error:", error);
      throw new Error("Failed to get agent tool call from Gemini.");
    }
  }

  /** Returns a snapshot of the Gemini API call statistics for this session. */
  static getCallStats(): { total: number; success: number; error: number } {
    return { ...geminiStats };
  }
}
