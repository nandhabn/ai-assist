/**
 * src/utils/batchingProvider.ts
 *
 * BatchingAIProvider
 * ──────────────────
 * Collects concurrent `predictNextAction` calls within a short flush window
 * (default: 80 ms) and merges them into a SINGLE Gemini API request.
 *
 * Why?  The Gemini free-tier allows very few requests per minute.  When the
 * agent fires several predictions in quick succession each one would normally
 * eat a quota token.  This provider waits a tick, groups everything that
 * arrived in that window, and posts one batched prompt — returning an array of
 * N results and routing each answer back to the original `await` call.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  caller A:  const pa = await batchProv.predictNextAction(ctxA)  ──┐    │
 * │  caller B:  const pb = await batchProv.predictNextAction(ctxB)  ──┤    │
 * │  caller C:  const pc = await batchProv.predictNextAction(ctxC)  ──┤    │
 * │                                                                   │    │
 * │  (all three park here while the flush-window is open)            │    │
 * │                                                                   ▼    │
 * │  [flush]  ──► single Gemini call with 3 contexts in one prompt        │
 * │           ◄──  array of 3 AIPredictions                               │
 * │                                                                        │
 * │  pa, pb, pc each resolve  ─►  callers continue                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `generateFormData` calls are passed through to the underlying provider
 * individually because each form is unique and rarely concurrent.
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
  formatPageMeta,
  formatFieldDescriptions,
  buildFormDataPrompt,
} from "@/config/prompts";

// ─── Config ───────────────────────────────────────────────────────────────────

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

export interface BatchingProviderOptions {
  /**
   * Time (ms) to wait after the first queued request before flushing the batch.
   * A larger window gathers more requests per API call; a smaller one reduces
   * latency for solo requests.  Default: 80 ms.
   */
  flushWindowMs?: number;

  /**
   * Maximum number of prediction requests per batch.
   * If the window fills before the timer fires the batch is flushed early.
   * Default: 8.
   */
  maxBatchSize?: number;

  /**
   * Fallback AIProvider used for `generateFormData` (and for single-item
   * prediction batches when you want to reuse an already-configured provider).
   * If omitted the class talks to Gemini directly.
   */
  fallbackProvider?: AIProvider;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[BatchingProvider] [${ts}] ${msg}`);
}

/**
 * Parses a Gemini response string into T.
 * Handles markdown code fences and attempts to repair truncated JSON.
 */
function safeJsonParse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text) as T;
  } catch (firstErr) {
    const msg = (firstErr as Error).message ?? "";
    if (!msg.includes("Unterminated") && !msg.includes("Unexpected end"))
      throw firstErr;

    let repaired = text;
    const quoteCount = (repaired.match(/(?<!\\)"/g) ?? []).length;
    if (quoteCount % 2 !== 0) repaired += '"';
    const stack: string[] = [];
    for (const ch of repaired) {
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
    repaired += stack.reverse().join("");
    try {
      const result = JSON.parse(repaired) as T;
      console.warn("[BatchingProvider] Repaired truncated JSON.");
      return result;
    } catch {
      throw firstErr;
    }
  }
}

// ─── Pending item type ────────────────────────────────────────────────────────

interface PendingPrediction {
  context: CompactContext;
  resolve: (v: AIPrediction) => void;
  reject: (e: unknown) => void;
}

// ─── Batch prompt builders ────────────────────────────────────────────────────

/**
 * Builds a single prompt that asks Gemini to return an array of N predictions,
 * one for each supplied context.
 */
function buildBatchPredictionPrompt(contexts: CompactContext[]): string {
  const contextBlocks = contexts
    .map((ctx, i) => {
      const metaBlock = formatPageMeta(ctx.pageMeta, "    ");
      const metaSection = metaBlock ? `\n${metaBlock}\n` : "";
      const missionSection = ctx.mission
        ? `\n    User Mission: ${ctx.mission}\n`
        : "";
      const historySection =
        ctx.stepHistory && ctx.stepHistory.length > 0
          ? `\n    Completed Steps:\n${ctx.stepHistory
              .slice(-5)
              .map((s, j) => `      ${j + 1}. ${s.action} (on ${s.pageUrl})`)
              .join("\n")}\n`
          : "";

      const planSection = ctx.plan
        ? `\n    == PLAN ==\n${ctx.plan
            .split("\n")
            .map((l) => `    ${l}`)
            .join(
              "\n",
            )}\n    == EXECUTE PLAN STEP ${ctx.currentPlanStep ?? 1} NOW ==\n`
        : "";

      return `--- Context ${i} ---
${metaSection}${missionSection}${planSection}${historySection}    Page Intent: ${ctx.pageIntent}
    Last Action: ${ctx.lastActionLabel || "None"}
    Visible Actions: ${JSON.stringify(ctx.topVisibleActions)}
    Form Fields: ${JSON.stringify(ctx.formFields)}`;
    })
    .join("\n\n");

  return `You are an expert at predicting user actions on web pages.
You will receive ${contexts.length} independent page contexts numbered 0 to ${contexts.length - 1}.
For EACH context, predict the single most likely next action.

${contextBlocks}

Respond with a STRICT JSON array containing exactly ${contexts.length} prediction objects (index 0 to ${contexts.length - 1}):
[
  {
    "predictedActionLabel": "string (must be one of the Visible Actions for context 0)",
    "reasoning": "string",
    "confidenceEstimate": 0.0,
    "inputText": "string (ONLY when the action is to TYPE text — omit for clicks)"
  },
  ...
]

Rules:
- The array must have EXACTLY ${contexts.length} elements in order.
- Each element corresponds to the context with the matching array index.
- "predictedActionLabel" must be an exact match of one of the Visible Actions listed for that context.
- Only include "inputText" when the action involves typing into a field.
- Do NOT wrap the array in any outer object — the top-level response must be a JSON array.`;
}

// ─── BatchingAIProvider ───────────────────────────────────────────────────────

/**
 * AIProvider implementation that batches concurrent `predictNextAction` calls
 * into a single Gemini API request, then fans out the results to each caller.
 *
 * Each caller simply does `await provider.predictNextAction(ctx)` — the
 * batching is completely transparent.
 */
export class BatchingAIProvider implements AIProvider {
  private readonly apiKey: string;
  private readonly flushWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly fallbackProvider?: AIProvider;

  // Pending batch state
  private pendingBatch: PendingPrediction[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Stats
  private stats = { batches: 0, requests: 0, saved: 0 };

  constructor(apiKey: string, options: BatchingProviderOptions = {}) {
    if (!apiKey)
      throw new Error("BatchingAIProvider requires a Gemini API key.");
    this.apiKey = apiKey;
    this.flushWindowMs = options.flushWindowMs ?? 80;
    this.maxBatchSize = options.maxBatchSize ?? 8;
    this.fallbackProvider = options.fallbackProvider;
  }

  // ── AIProvider interface ──────────────────────────────────────────────────

  /**
   * Queues this context in the pending batch.
   * The returned Promise will resolve (or reject) once the batch is flushed
   * and the Gemini response is received — the caller just awaits normally.
   */
  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    return new Promise<AIPrediction>((resolve, reject) => {
      this.pendingBatch.push({ context, resolve, reject });
      log(
        `Queued prediction (batch size now: ${this.pendingBatch.length}). ` +
          `Flush in ≤${this.flushWindowMs}ms.`,
      );

      if (this.pendingBatch.length >= this.maxBatchSize) {
        // Batch is full — flush immediately without waiting for the timer
        this.cancelFlushTimer();
        this.flush();
      } else if (!this.flushTimer) {
        // Start the flush window timer
        this.flushTimer = setTimeout(() => this.flush(), this.flushWindowMs);
      }
    });
  }

  /**
   * Passed directly to the fallback provider (or a single Gemini call).
   * Form-fill requests are almost never concurrent so dedicated batching is
   * not necessary here.
   */
  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    if (this.fallbackProvider) {
      return this.fallbackProvider.generateFormData(fields, pageContext);
    }
    return this.geminiGenerateFormData(fields, pageContext);
  }

  // ── Flush logic ───────────────────────────────────────────────────────────

  private cancelFlushTimer() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Drains the pending batch and dispatches one Gemini request for all items.
   * Each item's Promise is resolved/rejected as the results arrive.
   */
  private flush(): void {
    this.cancelFlushTimer();

    const batch = this.pendingBatch.splice(0); // grab everything, reset array
    if (batch.length === 0) return;

    this.stats.batches++;
    this.stats.requests += batch.length;
    // Requests "saved" = how many extra API calls we avoided
    this.stats.saved += batch.length - 1;

    log(
      `Flushing batch of ${batch.length} predictions ` +
        `(total saved so far: ${this.stats.saved}).`,
    );

    // Run async without blocking the caller — each item's Promise will
    // resolve/reject individually once the API responds.
    this.dispatchBatch(batch).catch(() => {
      /* errors are forwarded to individual item.reject() inside dispatchBatch */
    });
  }

  /**
   * Sends all contexts in a single Gemini call, then distributes results.
   */
  private async dispatchBatch(batch: PendingPrediction[]): Promise<void> {
    // Single item? Skip the batching overhead and use a normal prompt.
    if (batch.length === 1) {
      const { context, resolve, reject } = batch[0];
      try {
        const result = await this.geminiPredict(context);
        resolve(result);
      } catch (err) {
        reject(err);
      }
      return;
    }

    const prompt = buildBatchPredictionPrompt(batch.map((b) => b.context));

    let predictions: AIPrediction[];
    try {
      log(`Sending batched prompt (${batch.length} contexts)…`);
      const raw = await this.geminiRawCall(prompt);
      log(`Batch RAW RESPONSE:\n${raw}`);
      try {
        predictions = safeJsonParse<AIPrediction[]>(raw);
      } catch (parseErr) {
        console.error(
          "[BatchingProvider] Batch JSON parse FAILED. Raw text:",
          raw,
        );
        throw parseErr;
      }

      if (!Array.isArray(predictions)) {
        throw new Error("Gemini batch response is not a JSON array.");
      }
      if (predictions.length !== batch.length) {
        throw new Error(
          `Gemini returned ${predictions.length} predictions but expected ${batch.length}.`,
        );
      }

      log(
        `Batch response received — distributing ${predictions.length} results.`,
      );
      for (let i = 0; i < batch.length; i++) {
        const p = predictions[i];
        if (
          !p.predictedActionLabel ||
          !p.reasoning ||
          typeof p.confidenceEstimate !== "number"
        ) {
          batch[i].reject(
            new Error(`Invalid prediction at index ${i}: ${JSON.stringify(p)}`),
          );
        } else {
          batch[i].resolve(p);
        }
      }
    } catch (err) {
      log(`Batch dispatch failed: ${err}. Falling back to individual calls.`);
      // Fallback: send each item individually so no caller is left hanging
      await Promise.allSettled(
        batch.map(async ({ context, resolve, reject }) => {
          try {
            resolve(await this.geminiPredict(context));
          } catch (e) {
            reject(e);
          }
        }),
      );
    }
  }

  // ── Gemini helpers ────────────────────────────────────────────────────────

  /**
   * Low-level Gemini call — returns the raw text of the first candidate part.
   */
  private async geminiRawCall(prompt: string): Promise<string> {
    const response = await fetch(GEMINI_ENDPOINT, {
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
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text as string;
  }

  /** Single-context prediction (used for batch.length === 1 and fallback). */
  private async geminiPredict(context: CompactContext): Promise<AIPrediction> {
    const prompt = buildPredictionPrompt(context);
    const raw = await this.geminiRawCall(prompt);
    log(`Single predict RAW RESPONSE:\n${raw}`);
    let prediction: AIPrediction;
    try {
      prediction = safeJsonParse<AIPrediction>(raw);
    } catch (parseErr) {
      console.error(
        "[BatchingProvider] Single predict JSON parse FAILED. Raw text:",
        raw,
      );
      throw parseErr;
    }
    if (
      !prediction.predictedActionLabel ||
      !prediction.reasoning ||
      typeof prediction.confidenceEstimate !== "number"
    ) {
      throw new Error("Invalid JSON structure from Gemini API.");
    }
    return prediction;
  }

  /** Direct Gemini generateFormData — used when no fallbackProvider is set. */
  private async geminiGenerateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    const fieldDescriptions = formatFieldDescriptions(fields);
    const prompt = buildFormDataPrompt(fieldDescriptions, pageContext);
    const raw = await this.geminiRawCall(prompt);
    log(`generateFormData RAW RESPONSE:\n${raw}`);
    let parsed: AIFormData;
    try {
      parsed = safeJsonParse<AIFormData>(raw);
    } catch (parseErr) {
      console.error(
        "[BatchingProvider] generateFormData JSON parse FAILED. Raw text:",
        raw,
      );
      throw parseErr;
    }
    if (!parsed.fieldValues || typeof parsed.fieldValues !== "object") {
      throw new Error("Invalid form data structure from Gemini API.");
    }
    return parsed;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /** Returns a snapshot of batching statistics for this session. */
  getStats() {
    return { ...this.stats };
  }

  /** How many prediction requests are currently waiting for the flush. */
  get pendingCount(): number {
    return this.pendingBatch.length;
  }
}

/**
 * Convenience factory.
 *
 * @example
 * const provider = createBatchingProvider(apiKey);
 * // All of these share one API call if they fire within 80 ms of each other:
 * const [p1, p2, p3] = await Promise.all([
 *   provider.predictNextAction(ctxA),
 *   provider.predictNextAction(ctxB),
 *   provider.predictNextAction(ctxC),
 * ]);
 */
export function createBatchingProvider(
  apiKey: string,
  options?: BatchingProviderOptions,
): BatchingAIProvider {
  return new BatchingAIProvider(apiKey, options);
}
