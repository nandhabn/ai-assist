// src/utils/geminiProvider.ts

import { AIProvider, CompactContext, AIPrediction, FormFieldInfo, AIFormData } from "../types/ai";

function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString('en-GB')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

const GEMINI_API_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";

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
    const { pageIntent, lastActionLabel, topVisibleActions, formFields } =
      context;

    aiLog(`[Gemini] predictNextAction START | Intent: ${pageIntent} | Actions: ${topVisibleActions.length} | Fields: ${formFields.length}`);

    const prompt = `
      You are an expert at predicting user actions on a web page.
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

    try {
      const response = await fetch(
        `${GEMINI_API_ENDPOINT}?key=${this.apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
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

      return prediction;
    } catch (error) {
      aiLog(`[Gemini] predictNextAction ERROR | ${error}`);
      console.error("Error in GeminiProvider:", error);
      throw new Error("Failed to get prediction from Gemini.");
    }
  }

  async generateFormData(fields: FormFieldInfo[], pageContext?: string): Promise<AIFormData> {
    aiLog(`[Gemini] generateFormData START | Fields: ${fields.length} | Context: ${pageContext || 'none'}`);
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
      const response = await fetch(
        `${GEMINI_API_ENDPOINT}?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        console.error("Gemini API form data request failed:", response.status, errorBody);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();
      const resultText = data.candidates[0].content.parts[0].text;
      const parsed = JSON.parse(resultText) as AIFormData;

      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure from Gemini API.");
      }

      aiLog(`[Gemini] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(', ')}`);
      return parsed;
    } catch (error) {
      aiLog(`[Gemini] generateFormData ERROR | ${error}`);
      console.error("Error generating form data with Gemini:", error);
      throw new Error("Failed to generate form data from Gemini.");
    }
  }
}
