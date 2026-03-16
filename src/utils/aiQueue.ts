/**
 * src/utils/aiQueue.ts
 *
 * Wraps AIProvider instances with:
 *  1. A serial request queue — prevents burst hammering of APIs.
 *  2. Exponential backoff on 429 / quota errors (15 s → 30 s → 60 s → 120 s).
 *  3. Automatic failover — if the primary provider exhausts retries, the next
 *     provider in the chain is promoted and the request is tried again.
 *
 * Usage:
 *   const provider = buildQueuedProvider([chatgptProvider, geminiProvider]);
 */

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  AgentToolCall,
  FormFieldInfo,
  AIFormData,
} from "../types/ai";

// ─── Config ───────────────────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 15_000; // 15 s after first 429
const MAX_BACKOFF_MS = 120_000; // cap at 2 min
const MAX_RETRIES_PER_PROVIDER = 3; // retry same provider N times before failover
const MIN_REQUEST_GAP_MS = 1_000; // always wait ≥1 s between requests

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function is429(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("quota") ||
      msg.includes("too many requests")
    );
  }
  return false;
}

function queueLog(msg: string) {
  console.log(`[AIQueue] ${msg}`);
}

// ─── Queue item ───────────────────────────────────────────────────────────────

interface QItem<T> {
  label: string;
  fn: (provider: AIProvider) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

// ─── QueuedAIProvider ─────────────────────────────────────────────────────────

/**
 * Wraps an ordered list of AIProvider instances.
 * All calls are serialised and rate-limited with automatic backoff + failover.
 */
export class QueuedAIProvider implements AIProvider {
  private providers: AIProvider[];
  private activeIndex = 0;

  // Per-provider backoff state
  private consecutiveFailures = 0;
  private backoffMs = 0;

  // Queue state
  private queue: QItem<unknown>[] = [];
  private processing = false;
  private lastRequestAt = 0;

  constructor(providers: AIProvider[]) {
    if (providers.length === 0)
      throw new Error("QueuedAIProvider: need at least one provider");
    this.providers = providers;
  }

  // ── Public AIProvider interface ──────────────────────────────────────────

  async predictNextAction(context: CompactContext): Promise<AIPrediction> {
    return this.enqueue("predictNextAction", (p) =>
      p.predictNextAction(context),
    );
  }

  async generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData> {
    return this.enqueue("generateFormData", (p) =>
      p.generateFormData(fields, pageContext),
    );
  }

  async callAgentTool(context: CompactContext): Promise<AgentToolCall> {
    // Find the first provider in the chain that supports callAgentTool.
    // This bypasses the standard queue so the agent loop isn't blocked by
    // other in-flight requests, and avoids routing to providers that don't
    // implement the tool-call interface.
    const capable = this.providers.find(
      (p) => typeof p.callAgentTool === "function",
    );
    if (!capable) {
      throw new Error(
        "QueuedAIProvider: no provider in the chain implements callAgentTool",
      );
    }
    return capable.callAgentTool!(context);
  }

  // ── Queue machinery ──────────────────────────────────────────────────────

  private enqueue<T>(
    label: string,
    fn: (provider: AIProvider) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        fn: fn as (p: AIProvider) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Enforce minimum gap between requests
      const gap = MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt);
      if (gap > 0) await sleep(gap);

      // Apply backoff if previous request hit a rate limit
      if (this.backoffMs > 0) {
        queueLog(
          `Backing off ${this.backoffMs / 1000}s (provider ${this.activeIndex}) …`,
        );
        await sleep(this.backoffMs);
      }

      const item = this.queue.shift()!;
      let resolved = false;

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
        const provider = this.providers[this.activeIndex];

        try {
          this.lastRequestAt = Date.now();
          const result = await item.fn(provider);

          // ✓ Success — reset backoff
          this.backoffMs = 0;
          this.consecutiveFailures = 0;
          item.resolve(result);
          resolved = true;
          break;
        } catch (err) {
          if (is429(err)) {
            this.consecutiveFailures++;
            const delay = Math.min(
              INITIAL_BACKOFF_MS * Math.pow(2, this.consecutiveFailures - 1),
              MAX_BACKOFF_MS,
            );

            if (attempt < MAX_RETRIES_PER_PROVIDER) {
              // Retry same provider after backoff
              queueLog(
                `429 on provider[${this.activeIndex}] — retry ${attempt}/${MAX_RETRIES_PER_PROVIDER - 1} in ${delay / 1000}s`,
              );
              await sleep(delay);
            } else if (this.activeIndex < this.providers.length - 1) {
              // Exhauted retries on this provider — failover
              this.activeIndex++;
              this.consecutiveFailures = 0;
              this.backoffMs = 0;
              queueLog(
                `429 retries exhausted — failing over to provider[${this.activeIndex}]`,
              );
              // attempt loop will retry on the new provider index next iteration
              attempt = 0; // reset (incremented to 1 at top of loop)
              continue;
            } else {
              // All providers exhausted
              queueLog("All providers rate-limited. Request rejected.");
              this.backoffMs = delay; // carry over backoff for next item
              item.reject(
                new Error(
                  `AI rate-limited: all providers returned 429 (last: ${err})`,
                ),
              );
              resolved = true;
              break;
            }
          } else {
            // Non-429 error — reject immediately without retry
            item.reject(err);
            resolved = true;
            break;
          }
        }
      }

      if (!resolved) {
        item.reject(
          new Error(
            `[AIQueue] Request '${item.label}' failed after all retries`,
          ),
        );
      }
    }

    this.processing = false;
  }

  /** Returns the index of the currently active provider. */
  get activeProviderIndex(): number {
    return this.activeIndex;
  }

  /** Reset back to the primary provider and clear backoff state. */
  resetToPrimary(): void {
    this.activeIndex = 0;
    this.backoffMs = 0;
    this.consecutiveFailures = 0;
    queueLog("Reset to primary provider.");
  }
}

/**
 * Convenience factory: builds a QueuedAIProvider from an ordered list of
 * raw providers (non-null). Primary = first, fallbacks = rest.
 */
export function buildQueuedProvider(providers: AIProvider[]): QueuedAIProvider {
  return new QueuedAIProvider(providers);
}
