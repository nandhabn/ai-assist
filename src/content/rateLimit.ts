/**
 * Unified AI rate limiter and call logger.
 * State lives on `window` so all script instances (double-injection) share it.
 */

export function aiLog(msg: string): void {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

export const AI_MIN_INTERVAL = 10_000;      // 10 s minimum between any AI call
export const AI_MAX_CALLS_PER_WINDOW = 4;   // Max 4 AI calls per window
export const AI_WINDOW_DURATION = 120_000;  // 2-minute sliding window

type RateLimiterState = { lastCall: number; count: number; windowStart: number };

export function getRLState(): RateLimiterState {
  if (!(window as any).__aiRateLimiter) {
    (window as any).__aiRateLimiter = { lastCall: 0, count: 0, windowStart: Date.now() };
  }
  return (window as any).__aiRateLimiter as RateLimiterState;
}

export function canMakeAICall(): boolean {
  const now = Date.now();
  const s = getRLState();
  if (now - s.windowStart > AI_WINDOW_DURATION) {
    s.count = 0;
    s.windowStart = now;
  }
  return now - s.lastCall >= AI_MIN_INTERVAL && s.count < AI_MAX_CALLS_PER_WINDOW;
}

export function recordAICall(): void {
  const s = getRLState();
  s.lastCall = Date.now();
  s.count++;
  aiLog(
    `API call recorded | Count this window: ${s.count}/${AI_MAX_CALLS_PER_WINDOW} | Window resets in: ${Math.round((AI_WINDOW_DURATION - (Date.now() - s.windowStart)) / 1000)}s`,
  );
}
