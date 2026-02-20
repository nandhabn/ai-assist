// src/utils/geminiProvider.ts

import { AIProvider, CompactContext, AIPrediction } from '../types/ai';

const GEMINI_API_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

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
      throw new Error('GeminiProvider requires an API key.');
    }
    this.apiKey = apiKey;
  }

  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    const { pageIntent, lastActionLabel, topVisibleActions, formFields } = context;

    const prompt = `
      You are an expert at predicting user actions on a web page.
      Based on the provided context, predict the single most likely next action.

      Current Page Intent: ${pageIntent}
      Last Action Taken: ${lastActionLabel || 'None'}
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
      const response = await fetch(`${GEMINI_API_ENDPOINT}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 2048,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('Gemini API request failed:', response.status, errorBody);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();
      const predictionText = data.candidates[0].content.parts[0].text;
      const prediction = JSON.parse(predictionText) as AIPrediction;

      // Basic validation of the response
      if (
        !prediction.predictedActionLabel ||
        !prediction.reasoning ||
        typeof prediction.confidenceEstimate !== 'number'
      ) {
        throw new Error('Invalid JSON structure from Gemini API.');
      }

      return prediction;
    } catch (error) {
      console.error('Error in GeminiProvider:', error);
      throw new Error('Failed to get prediction from Gemini.');
    }
  }
}
