/**
 * ChatGPT Tab Provider
 *
 * Uses an already-open ChatGPT browser tab as the AI backend instead of
 * calling the OpenAI API directly. No API key required.
 *
 * Flow:
 *   content.ts  →  background.ts  →  chatgptBridge.ts (on chat.openai.com)
 *                                 ←  response text
 */

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

/** Send a plain-text prompt to the open ChatGPT tab via the background. */
async function sendViaBridge(prompt: string): Promise<string> {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Ask background to relay the prompt. Background ACKs immediately;
  //    the actual result arrives asynchronously via chrome.storage.session.
  await new Promise<void>((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: "CHATGPT_TAB_PROXY", prompt, requestId },
      (ack) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (!ack?.queued)
          return reject(new Error(ack?.error || "Bridge relay failed"));
        resolve();
      },
    );
  });

  // 2. Poll via background (content scripts can't access chrome.storage.session directly)
  const TIMEOUT = 90_000;
  const POLL_INTERVAL = 800;
  const deadline = Date.now() + TIMEOUT;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const result = await new Promise<{
      success: boolean;
      response?: string;
      error?: string;
    } | null>((resolve) => {
      chrome.runtime.sendMessage(
        { action: "CHATGPT_BRIDGE_POLL", requestId },
        (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res?.result ?? null);
        },
      );
    });
    if (result) {
      if (!result.success)
        throw new Error(result.error || "Bridge returned error");
      return result.response as string;
    }
  }

  throw new Error("Timed out waiting for ChatGPT tab response (90s)");
}

/** Extract the first JSON object from a string (handles markdown code blocks). */
function extractJson(text: string): string {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1)
    throw new Error("No JSON object found in response");
  return text.substring(start, end + 1);
}

export class ChatGPTTabProvider implements AIProvider {
  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    aiLog(
      `[ChatGPT Tab] predictNextAction START | Intent: ${context.pageIntent}`,
    );

    const prompt = buildPredictionPrompt(context);

    try {
      const raw = await sendViaBridge(prompt);
      aiLog(`[ChatGPT Tab] predictNextAction received response`);
      const prediction = JSON.parse(extractJson(raw)) as AIPrediction;
      if (
        !prediction.predictedActionLabel ||
        typeof prediction.confidenceEstimate !== "number"
      ) {
        throw new Error("Invalid prediction structure");
      }
      return prediction;
    } catch (error) {
      aiLog(`[ChatGPT Tab] predictNextAction ERROR | ${error}`);
      throw new Error(`ChatGPT Tab prediction failed: ${error}`);
    }
  }

  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    aiLog(
      `[ChatGPT Tab] generateFormData START | Fields: ${fields.length} | Context: ${pageContext || "none"}`,
    );

    const fieldDescriptions = formatFieldDescriptions(fields);
    const prompt = buildFormDataPrompt(fieldDescriptions, pageContext);

    try {
      const raw = await sendViaBridge(prompt);
      const parsed = JSON.parse(extractJson(raw)) as AIFormData;
      if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
        throw new Error("Invalid form data structure");
      }
      aiLog(
        `[ChatGPT Tab] generateFormData SUCCESS | Keys: ${Object.keys(parsed.fieldValues).join(", ")}`,
      );
      return parsed;
    } catch (error) {
      aiLog(`[ChatGPT Tab] generateFormData ERROR | ${error}`);
      throw new Error(`ChatGPT Tab form data failed: ${error}`);
    }
  }
}
