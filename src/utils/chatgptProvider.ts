// src/utils/chatgptProvider.ts

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  FormFieldInfo,
  AIFormData,
} from "../types/ai";
import {
  PREDICTION_SYSTEM_PROMPT,
  FORM_DATA_SYSTEM_PROMPT,
  buildPredictionPrompt,
  buildFormDataPrompt,
  formatFieldDescriptions,
} from "@/config/prompts";

function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

const OPENAI_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// --- Start: Type Definitions for API response ---

interface OpenAIChoice {
  message: {
    content: string;
  };
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
}

/**
 * Type guard to check if an object is a valid AIPrediction.
 * This provides runtime validation of the structure received from the API.
 * @param obj The object to check.
 * @returns True if the object conforms to the AIPrediction interface.
 */
function isAIPrediction(obj: any): obj is AIPrediction {
  return (
    obj &&
    typeof obj.predictedActionLabel === "string" &&
    typeof obj.reasoning === "string" &&
    typeof obj.confidenceEstimate === "number"
  );
}

// --- End: Type Definitions ---

/**
 * An AIProvider implementation that uses OpenAI's ChatGPT models.
 *
 * @Architectural-Note This class adheres to the AIProvider interface, making it
 * interchangeable with other providers like GeminiProvider. It is designed for use
 * in a secure environment where the API key is handled safely.
 *
 * @Security-Note The API key is a sensitive credential. It should be managed via
 * a backend proxy or securely stored using `chrome.storage.local`. Hardcoding
 * the key is a security risk and is strictly forbidden.
 */
export class ChatGPTProvider implements AIProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o-mini") {
    if (!apiKey) {
      throw new Error("ChatGPTProvider requires an API key.");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    const prompt = buildPredictionPrompt(context);

    aiLog(
      `[ChatGPT] predictNextAction START | Model: ${this.model} | Intent: ${context.pageIntent}`,
    );

    try {
      const response = await fetch(OPENAI_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: PREDICTION_SYSTEM_PROMPT,
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        // Check for quota errors specifically
        if (response.status === 429) {
          try {
            const errorJson = JSON.parse(errorBody);
            const quotaError =
              errorJson?.error?.code === "insufficient_quota" ||
              errorJson?.error?.type === "insufficient_quota";
            if (quotaError) {
              console.warn(
                "[ChatGPT Provider] API quota exceeded. Please check your OpenAI billing or use Gemini instead.",
              );
            }
          } catch {
            // errorBody wasn't valid JSON — ignore
          }
        }
        // Only log non-quota errors to avoid spam
        if (response.status !== 429) {
          console.error(
            "OpenAI API request failed:",
            response.status,
            errorBody,
          );
        }
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data: OpenAIResponse = await response.json();
      const messageContent = data.choices[0]?.message?.content;

      if (!messageContent) {
        throw new Error(
          "Invalid response structure from OpenAI API: No message content.",
        );
      }

      // The response from OpenAI may include markdown "```json" wrappers.
      const jsonString = this.extractJson(messageContent);
      const prediction = JSON.parse(jsonString);

      // Validate the structure of the parsed object.
      if (!isAIPrediction(prediction)) {
        console.error(
          "Parsed JSON does not match AIPrediction structure:",
          prediction,
        );
        throw new Error("Invalid JSON structure from OpenAI API.");
      }

      return prediction;
    } catch (error) {
      aiLog(`[ChatGPT] predictNextAction ERROR | ${error}`);
      console.error("Error in ChatGPTProvider:", error);
      // Re-throwing a more specific error is often better than a generic one.
      if (
        error instanceof Error &&
        error.message.startsWith("OpenAI API error")
      ) {
        throw error;
      }
      throw new Error("Failed to get prediction from OpenAI.");
    }
  }

  /**
   * Extracts a JSON string from a larger string, which might be wrapped in markdown.
   * @param content The string containing the JSON.
   * @returns The extracted JSON string.
   */
  private extractJson(content: string): string {
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error(
        "Could not find a valid JSON object in the API response.",
      );
    }

    return content.substring(jsonStart, jsonEnd + 1);
  }

  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    aiLog(
      `[ChatGPT] generateFormData START | Model: ${this.model} | Fields: ${fields.length} | Context: ${pageContext || "none"}`,
    );
    const fieldDescriptions = formatFieldDescriptions(fields);
    const prompt = buildFormDataPrompt(fieldDescriptions, pageContext);

    try {
      const response = await fetch(OPENAI_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: FORM_DATA_SYSTEM_PROMPT,
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status !== 429) {
          console.error(
            "OpenAI form data request failed:",
            response.status,
            errorBody,
          );
        }
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data: OpenAIResponse = await response.json();
      const messageContent = data.choices[0]?.message?.content;

      if (!messageContent) {
        throw new Error(
          "Invalid response structure from OpenAI API: No message content.",
        );
      }

      const jsonString = this.extractJson(messageContent);
      const parsed = JSON.parse(jsonString) as AIFormData;

      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure from OpenAI API.");
      }

      aiLog(
        `[ChatGPT] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(", ")}`,
      );
      return parsed;
    } catch (error) {
      aiLog(`[ChatGPT] generateFormData ERROR | ${error}`);
      console.error("Error generating form data with ChatGPT:", error);
      if (
        error instanceof Error &&
        error.message.startsWith("OpenAI API error")
      ) {
        throw error;
      }
      throw new Error("Failed to generate form data from OpenAI.");
    }
  }
}
