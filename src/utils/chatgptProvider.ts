// src/utils/chatgptProvider.ts

import { AIProvider, CompactContext, AIPrediction, FormFieldInfo, AIFormData } from "../types/ai";

function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString('en-GB')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
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
    const prompt = this.buildPrompt(context);

    aiLog(`[ChatGPT] predictNextAction START | Model: ${this.model} | Intent: ${context.pageIntent}`);

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
              content:
                "You are an expert at predicting user actions on a web page. Respond in STRICT JSON format.",
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
          const quotaError =
           errorBody?.error?.code === "insufficient_quota" ||
            errorBody?.error?.type === "insufficient_quota";
          if (quotaError) {
            console.warn(
              "[ChatGPT Provider] API quota exceeded. Please check your OpenAI billing or use Gemini instead.",
            );
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

  private buildPrompt(context: CompactContext): string {
    const { pageIntent, lastActionLabel, topVisibleActions, formFields } =
      context;
    return `
      Based on the provided context, predict the single most likely next action.

      Current Page Intent: ${pageIntent}
      Last Action Taken: ${lastActionLabel || "None"}
      Visible Actions: ${JSON.stringify(topVisibleActions)}
      Available Form Fields: ${JSON.stringify(formFields)}

      Respond in STRICT JSON format with the following structure:
      {
        "predictedActionLabel": "string (must be one of the Visible Actions)",
        "reasoning": "string (explain your choice in one sentence)",
        "confidenceEstimate": "number (a value between 0.0 and 1.0)"
      }
    `;
  }

  async generateFormData(fields: FormFieldInfo[], pageContext?: string): Promise<AIFormData> {
    aiLog(`[ChatGPT] generateFormData START | Model: ${this.model} | Fields: ${fields.length} | Context: ${pageContext || 'none'}`);
    const fieldDescriptions = fields.map((f, i) => {
      const parts: string[] = [`Field ${i + 1}:`];
      if (f.name) parts.push(`name="${f.name}"`);
      if (f.id) parts.push(`id="${f.id}"`);
      parts.push(`type="${f.type}"`);
      if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
      if (f.labelText) parts.push(`label="${f.labelText}"`);
      if (f.ariaLabel) parts.push(`aria-label="${f.ariaLabel}"`);
      if (f.options && f.options.length > 0) parts.push(`options=[${f.options.map(o => `"${o}"`).join(", ")}]`);
      return parts.join(" ");
    }).join("\n");

    const prompt = `
You are a test data generator for web form automation.
Generate realistic, contextually appropriate test data for the following form fields.
${pageContext ? `Page context: ${pageContext}` : ""}

Form Fields:
${fieldDescriptions}

Rules:
- Generate realistic-looking data (e.g., real-sounding names, valid email formats, strong passwords).
- For each field, return a mapping using the field's "name" attribute as the key. If "name" is empty, use "id". If both are empty, use "label" or "aria-label".
- Emails should use @example.com or @test.com domains.
- Passwords should be strong (12+ chars, mixed case, numbers, symbols).
- Phone numbers should be in a valid format.
- For select/dropdown fields with options listed, you MUST pick one of the provided options exactly as written.
- All generated values should be coherent with each other (e.g., same persona).

Respond in STRICT JSON format:
{
  "fieldValues": {
    "fieldKey1": "generated value 1",
    "fieldKey2": "generated value 2"
  }
}
    `;

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
              content:
                "You are a test data generator that produces realistic form data. Respond in STRICT JSON format.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status !== 429) {
          console.error("OpenAI form data request failed:", response.status, errorBody);
        }
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data: OpenAIResponse = await response.json();
      const messageContent = data.choices[0]?.message?.content;

      if (!messageContent) {
        throw new Error("Invalid response structure from OpenAI API: No message content.");
      }

      const jsonString = this.extractJson(messageContent);
      const parsed = JSON.parse(jsonString) as AIFormData;

      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure from OpenAI API.");
      }

      aiLog(`[ChatGPT] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(', ')}`);
      return parsed;
    } catch (error) {
      aiLog(`[ChatGPT] generateFormData ERROR | ${error}`);
      console.error("Error generating form data with ChatGPT:", error);
      if (error instanceof Error && error.message.startsWith("OpenAI API error")) {
        throw error;
      }
      throw new Error("Failed to generate form data from OpenAI.");
    }
  }
}
