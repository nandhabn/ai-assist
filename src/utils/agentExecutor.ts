/**
 * Autonomous Agent Executor
 *
 * Implements an observe → think → act → wait loop that drives autonomous
 * web interaction based on a user-defined mission prompt.
 *
 * The executor is decoupled from the DOM and AI providers — it receives
 * all dependencies via callbacks so it can be tested and reused easily.
 */

import type { PredictionResult, RankedPrediction } from "@/types/ai";
import type { AgentTurn, FormFieldInfo } from "@/types/ai";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Maximum steps before the agent auto-stops (safety guard). Default 30. */
  maxSteps: number;
  /** Maximum AI queries per agent session. Default 10. */
  maxAIQueries: number;
  /** Minimum confidence score to auto-execute. Default 0.10. */
  minConfidence: number;
  /** Delay (ms) between steps to avoid overwhelming the page. Default 2000. */
  stepDelayMs: number;
  /** Time (ms) to wait for the DOM to settle after an action. Default 1500. */
  settleTimeMs: number;
  /** Automatically fill detected forms before looking for a submit action. */
  autoFillForms: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 30,
  maxAIQueries: 20,
  minConfidence: 0.1,
  stepDelayMs: 2000,
  settleTimeMs: 1500,
  autoFillForms: true,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "stopped"
  | "error";

export interface AgentStep {
  stepNumber: number;
  action: string;
  selector: string;
  timestamp: number;
  success: boolean;
  pageUrl: string;
  /** The full prompt text sent to the AI for this step (for debugging / tooltip display). */
  prompt?: string;
}

/** Full record of a single agent session — persisted to chrome.storage.local. */
export interface AgentSession {
  id: string;
  mission: string;
  startUrl: string;
  startTime: number;
  endTime?: number;
  status: AgentStatus;
  plan?: string;
  estimatedSteps?: number;
  /** Current plan step (1-based), tracked separately from total tool-call count. */
  currentPlanStep?: number;
  steps: AgentStep[];
  /** Full turn-by-turn records (page state + AI decision + outcome). */
  turns: AgentTurn[];
  finalMessage?: string;
}

/**
 * Minimal in-flight executor state written to chrome.storage.local after every step
 * so the session can be resumed transparently after a full-page navigation.
 */
export interface AgentResumeSnapshot {
  session: AgentSession;
  stepCount: number;
  aiQueryCount: number;
  lastSelector: string;
  stuckCounter: number;
  visitedActions: Record<string, string[]>;
  filledFormSelectors: string[];
  turns: AgentTurn[];
}

/**
 * Callbacks the executor uses to interact with the page, AI, and UI.
 * Provided by content.ts at construction time.
 */
export interface AgentCallbacks {
  /** Build fresh predictions for the current page state (always AI-enhanced). */
  predict: () => Promise<PredictionResult>;
  /** Execute a prediction by clicking the target element. Returns true if element was found and clicked. */
  execute: (prediction: RankedPrediction) => Promise<boolean>;
  /** Detect whether there is an active form to fill. */
  detectForm: () => {
    detected: boolean;
    fields: FormFieldInfo[];
    form: HTMLFormElement | null;
  };
  /** Auto-fill the detected form. Returns true on success. */
  fillForm: (fields: FormFieldInfo[]) => Promise<boolean>;
  /** Called whenever agent status or step count changes. */
  onStatusChange: (
    status: AgentStatus,
    stepCount: number,
    message?: string,
  ) => void;
  /** Called after each step completes. */
  onStepComplete: (step: AgentStep) => void;
  /** Read and clear the last action failure string from shared state. */
  getLastActionFailure?: () => string | null;
  /** Write a failure hint into shared state for the next AI observation. */
  setLastActionFailure?: (msg: string | null) => void;
  /** Optional: called when the session finishes (complete / stop / error). */
  onSessionSave?: (session: AgentSession) => void;
}

// ─── Agent Executor ───────────────────────────────────────────────────────────

export class AgentExecutor {
  private config: AgentConfig;
  private callbacks: AgentCallbacks;

  private status: AgentStatus = "idle";
  private stepCount = 0;
  private steps: AgentStep[] = [];
  private abortController: AbortController | null = null;

  // Session tracking
  private session: AgentSession | null = null;

  // Stuck detection
  private lastSelector = "";
  private stuckCounter = 0;
  private static readonly MAX_STUCK = 3;

  // AI query budget
  private aiQueryCount = 0;

  // Track filled forms so we don't re-fill the same form in a loop
  private filledFormSelectors = new Set<string>();

  // Track visited actions per-URL to avoid infinite loops.
  // Scoped per URL so the same action on a different page state (SPA) isn't blocked.
  private visitedActions = new Map<string, Set<string>>();

  // Count consecutive scroll actions — if too many in a row, hint AI to stop.
  private consecutiveScrolls = 0;
  private static readonly MAX_CONSECUTIVE_SCROLLS = 3;

  // Count consecutive no-op tool calls (message / delay) that don't change page
  // state. After just 1 consecutive no-op the next call is intercepted and
  // returned as a failure so it shows as ⚠ in the very next observation prompt.
  private consecutiveNoOps = 0;
  private static readonly MAX_CONSECUTIVE_NO_OPS = 1;

  // Full turn history for rich AI context
  private turns: AgentTurn[] = [];

  constructor(callbacks: AgentCallbacks, config?: Partial<AgentConfig>) {
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start(mission = ""): Promise<void> {
    if (this.status === "running") return;
    this.reset();

    // Initialise session record
    this.session = {
      id: crypto.randomUUID(),
      mission,
      startUrl: window.location.href,
      startTime: Date.now(),
      status: "running",
      steps: this.steps,
      turns: this.turns,
    };

    this.status = "running";
    this.abortController = new AbortController();
    this.callbacks.onStatusChange("running", 0, "Agent started");
    try {
      await this.loop();
    } catch (err) {
      // status may have been changed to "stopped" by stop() during the loop
      if ((this.status as AgentStatus) !== "stopped") {
        this.status = "error";
        this.callbacks.onStatusChange("error", this.stepCount, String(err));
        this.saveSession("error", String(err));
      }
    }
  }

  stop(): void {
    if (this.status === "idle") return;
    this.status = "stopped";
    this.abortController?.abort();
    this.callbacks.onStatusChange(
      "stopped",
      this.stepCount,
      "Agent stopped by user",
    );
    this.saveSession("stopped", "Stopped by user");
  }

  pause(): void {
    if (this.status !== "running") return;
    this.status = "paused";
    this.abortController?.abort();
    this.callbacks.onStatusChange("paused", this.stepCount, "Agent paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
    this.abortController = new AbortController();
    this.callbacks.onStatusChange("running", this.stepCount, "Agent resumed");
    this.loop().catch((err) => {
      if (this.status !== "stopped") {
        this.status = "error";
        this.callbacks.onStatusChange("error", this.stepCount, String(err));
      }
    });
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getStepCount(): number {
    return this.stepCount;
  }

  getSteps(): readonly AgentStep[] {
    return this.steps;
  }

  getSession(): AgentSession | null {
    return this.session;
  }

  /** Update the current plan step (called by agentManager after each AI tool call). */
  setPlanStep(planStep: number): void {
    if (this.session) this.session.currentPlanStep = planStep;
  }

  /** Appends a full turn record (called by agentManager after each step). */
  addTurn(turn: AgentTurn): void {
    this.turns.push(turn);
    if (this.session) this.session.turns = this.turns;
  }

  getTurns(): readonly AgentTurn[] {
    return this.turns;
  }

  updateConfig(partial: Partial<AgentConfig>): void {
    Object.assign(this.config, partial);
  }

  /**
   * Returns a serialisable snapshot of the current in-flight state so the
   * session can be persisted to storage before a page navigation and
   * restored on the next page load via continueFrom().
   */
  getResumeSnapshot(): AgentResumeSnapshot | null {
    if (
      !this.session ||
      this.status === "idle" ||
      this.status === "completed" ||
      this.status === "stopped" ||
      this.status === "error"
    )
      return null;
    return {
      session: {
        ...this.session,
        steps: [...this.steps],
        turns: [...this.turns],
      },
      stepCount: this.stepCount,
      aiQueryCount: this.aiQueryCount,
      lastSelector: this.lastSelector,
      stuckCounter: this.stuckCounter,
      visitedActions: Object.fromEntries(
        Array.from(this.visitedActions.entries()).map(([url, set]) => [
          url,
          Array.from(set),
        ]),
      ),
      filledFormSelectors: Array.from(this.filledFormSelectors),
      turns: [...this.turns],
    };
  }

  /**
   * Restores executor state from a persisted snapshot (written before the
   * previous page navigated away) and continues the mission loop — no reset,
   * no re-planning.
   */
  async continueFrom(snapshot: AgentResumeSnapshot): Promise<void> {
    if (this.status === "running") return;

    // Restore in-flight state
    this.turns = [...(snapshot.turns ?? [])];
    this.session = {
      ...snapshot.session,
      steps: [...snapshot.session.steps],
      turns: this.turns,
    };
    this.stepCount = snapshot.stepCount;
    this.steps = [...snapshot.session.steps];
    this.aiQueryCount = snapshot.aiQueryCount;
    this.lastSelector = snapshot.lastSelector;
    this.stuckCounter = snapshot.stuckCounter;
    this.visitedActions = new Map(
      Object.entries(snapshot.visitedActions).map(([url, keys]) => [
        url,
        new Set(keys),
      ]),
    );
    this.filledFormSelectors = new Set(snapshot.filledFormSelectors);
    this.consecutiveNoOps = 0;
    this.consecutiveScrolls = 0;

    this.status = "running";
    this.abortController = new AbortController();
    this.callbacks.onStatusChange(
      "running",
      this.stepCount,
      `Continuing after navigation (step ${this.stepCount})…`,
    );

    try {
      await this.loop();
    } catch (err) {
      if ((this.status as AgentStatus) !== "stopped") {
        this.status = "error";
        this.callbacks.onStatusChange("error", this.stepCount, String(err));
        this.saveSession("error", String(err));
      }
    }
  }

  // ── Core Loop ─────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.status === "running" && this.stepCount < this.config.maxSteps) {
      // 1. Wait for DOM to settle after previous action
      await this.waitForSettle();
      if (this.status !== "running") break;

      // 2. Pause between steps so the page (and user) can keep up
      await this.delay(this.config.stepDelayMs);
      if (this.status !== "running") break;

      // 3. Form auto-fill (before predicting next click)
      if (this.config.autoFillForms) {
        const formInfo = this.callbacks.detectForm();
        if (formInfo.detected && formInfo.fields.length > 0) {
          const formId = formInfo.form
            ? this.formIdentifier(formInfo.form)
            : "__anonymous";
          if (!this.filledFormSelectors.has(formId)) {
            const filled = await this.callbacks.fillForm(formInfo.fields);
            this.filledFormSelectors.add(formId);
            if (filled) {
              this.recordStep("Auto-filled form", formId, true);
              // Give frameworks time to run validation
              await this.delay(800);
              if (this.status !== "running") break;
              // Re-observe after fill — the predictions will now focus on submit
              continue;
            }
          }
        }
      }

      // 4. Check AI query budget
      if (this.aiQueryCount >= this.config.maxAIQueries) {
        this.finish(`AI query limit reached (${this.config.maxAIQueries})`);
        break;
      }

      // 5. Predict next action (AI-powered)
      this.aiQueryCount++;
      let result: PredictionResult;
      try {
        result = await this.callbacks.predict();
      } catch (err) {
        console.error("[AgentExecutor] Prediction failed:", err);
        // One prediction failure is not fatal — retry next iteration
        this.stuckCounter++;
        if (this.stuckCounter >= AgentExecutor.MAX_STUCK) {
          this.finish("Prediction keeps failing");
          break;
        }
        continue;
      }

      if (!result.topThree.length) {
        this.finish(
          result.isDone
            ? (result.doneReason ?? "Mission complete")
            : "No actionable elements found",
        );
        break;
      }

      const topPrediction = result.topThree[0];

      // 5. Confidence gate
      if (
        result.confidence < this.config.minConfidence &&
        topPrediction.totalScore < 0.2
      ) {
        this.finish(
          `Confidence too low (${(result.confidence * 100).toFixed(0)}%)`,
        );
        break;
      }

      // 6. Skip already-visited actions on the current URL to break loops.
      // Scrolls are exempt (scrolling the same direction multiple times is valid).
      const currentUrl = window.location.href;
      const actionKey = AgentExecutor.stableActionKey(
        topPrediction.action.selector,
      );
      if (actionKey && this.hasVisited(currentUrl, actionKey)) {
        // Try the next-best unvisited prediction
        const freshPred = result.topThree.find((p) => {
          const k = AgentExecutor.stableActionKey(p.action.selector);
          return !k || !this.hasVisited(currentUrl, k);
        });
        if (!freshPred) {
          // All top-3 candidates have been tried on this URL.
          this.stuckCounter++;
          if (this.stuckCounter >= AgentExecutor.MAX_STUCK) {
            this.finish(
              "All candidate actions visited and AI could not suggest a new path",
            );
            break;
          }
          this.callbacks.setLastActionFailure?.(
            "All candidate actions on this page have already been tried. " +
              "If the mission is complete, signal isDone. " +
              "Otherwise, suggest a completely different action or navigation path.",
          );
          // Clear only the current page's visited entries so retries aren't blocked.
          this.clearVisitedForUrl(currentUrl);
          continue;
        }
        // Use it instead (add to visited only once it succeeds)
        this.lastSelector = freshPred.action.selector;
        this.stuckCounter = 0;
        if (this.status !== "running") break;
        const freshSuccess = await this.callbacks.execute(freshPred);
        this.recordStep(
          freshPred.action.label,
          freshPred.action.selector,
          freshSuccess,
        );
        if (freshSuccess) {
          const freshKey = AgentExecutor.stableActionKey(
            freshPred.action.selector,
          );
          if (freshKey) this.markVisited(currentUrl, freshKey);
        }
        continue;
      }

      // 7. Stuck detection — same selector repeatedly (secondary guard)
      if (topPrediction.action.selector === this.lastSelector) {
        this.stuckCounter++;
        if (this.stuckCounter >= AgentExecutor.MAX_STUCK) {
          this.finish("Agent appears stuck — same action repeated");
          break;
        }
      } else {
        this.stuckCounter = 0;
      }
      this.lastSelector = topPrediction.action.selector;

      // 8. Execute — bail out if the agent was stopped while AI was thinking
      if (this.status !== "running") break;
      const success = await this.callbacks.execute(topPrediction);
      this.recordStep(
        topPrediction.action.label,
        topPrediction.action.selector,
        success,
      );

      // Track consecutive scrolls — inject an observation hint if stuck scrolling.
      const isScroll =
        topPrediction.action.selector.startsWith("__tool__:") &&
        topPrediction.action.selector.includes('"tool":"scroll"');
      if (isScroll) {
        this.consecutiveScrolls++;
        if (this.consecutiveScrolls >= AgentExecutor.MAX_CONSECUTIVE_SCROLLS) {
          this.callbacks.setLastActionFailure?.(
            `Scrolling has revealed no new elements for ${this.consecutiveScrolls} consecutive steps. ` +
              "Stop scrolling and instead click a visible element already present on the page.",
          );
        }
      } else {
        this.consecutiveScrolls = 0;
      }

      // Track consecutive no-op tools (message / delay) that don't modify page state.
      // After MAX_CONSECUTIVE_NO_OPS, the failure is injected SYNCHRONOUSLY so it
      // shows as ⚠ LAST ACTION FAILED in the very next observation prompt — which
      // is far more prominent than a soft hint lost in the observation section.
      const isNoOp =
        topPrediction.action.selector.startsWith("__tool__:") &&
        (topPrediction.action.selector.includes('"tool":"message"') ||
          topPrediction.action.selector.includes('"tool":"delay"'));
      if (isNoOp) {
        this.consecutiveNoOps++;
        if (this.consecutiveNoOps > AgentExecutor.MAX_CONSECUTIVE_NO_OPS) {
          this.callbacks.setLastActionFailure?.(
            `FORBIDDEN: You called message() or delay() ${this.consecutiveNoOps} times in a row. ` +
              "message() is NOT a way to acknowledge plan steps. " +
              "Your ONLY valid next tools are: click, type, navigate, scroll, or done.",
          );
          this.recordStep(
            topPrediction.action.label,
            topPrediction.action.selector,
            false,
          );
          continue;
        }
      } else {
        this.consecutiveNoOps = 0;
      }

      // Add to visitedActions only on success, so failed-action retries aren't blocked.
      if (success && actionKey) {
        this.markVisited(currentUrl, actionKey);
      }

      if (!success) {
        // Don't stop — the failure reason is stored in state.lastActionFailure,
        // which buildPostActionObservation() will surface to the AI on the very
        // next think step so it can choose a recovery action.
        // stuckCounter is only used for the "same selector repeated" guard above.
        console.warn(
          "[Agent] Action failed — passing failure reason to AI for recovery.",
        );
      }
    }

    // Natural exit — max steps or fell through
    if (this.status === "running") {
      this.finish(
        this.stepCount >= this.config.maxSteps
          ? `Reached max steps (${this.config.maxSteps})`
          : "Agent finished",
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Returns a stable dedup key for visitedActions, stripping AI-generated noise
   * (reasoning text, confidence scores) from __tool__: selectors so that the
   * same logical action always maps to the same key regardless of how the AI
   * worded its reasoning.
   *
   * Returns null for scroll actions — scroll dedup is handled separately.
   */
  private static stableActionKey(selector: string): string | null {
    if (selector.startsWith("__tool__:")) {
      try {
        const tc = JSON.parse(selector.slice(9 /* "__tool__:".length */));
        if (tc.tool === "scroll") return null; // never deduplicate scrolls
        return `${tc.tool}:${JSON.stringify(tc.params ?? {})}`;
      } catch {
        // Fall through to default
      }
    }
    return selector;
  }

  /** Check if an action has been visited on the given URL */
  private hasVisited(url: string, key: string): boolean {
    return this.visitedActions.get(url)?.has(key) ?? false;
  }

  /** Mark an action as visited on the given URL */
  private markVisited(url: string, key: string): void {
    let set = this.visitedActions.get(url);
    if (!set) {
      set = new Set();
      this.visitedActions.set(url, set);
    }
    set.add(key);
  }

  /** Clear visited actions only for the given URL */
  private clearVisitedForUrl(url: string): void {
    this.visitedActions.delete(url);
  }

  private saveSession(status: AgentStatus, finalMessage?: string): void {
    if (!this.session) return;
    this.session.endTime = Date.now();
    this.session.status = status;
    this.session.steps = [...this.steps];
    this.session.turns = [...this.turns];
    this.session.finalMessage = finalMessage;
    try {
      this.callbacks.onSessionSave?.(this.session);
    } catch (err) {
      console.warn("[AgentExecutor] Session save failed:", err);
    }
  }

  private reset(): void {
    this.stepCount = 0;
    this.steps = [];
    this.turns = [];
    this.stuckCounter = 0;
    this.lastSelector = "";
    this.aiQueryCount = 0;
    this.filledFormSelectors.clear();
    this.visitedActions.clear();
    this.consecutiveScrolls = 0;
    this.consecutiveNoOps = 0;
  }

  private finish(reason: string): void {
    this.status = "completed";
    this.callbacks.onStatusChange("completed", this.stepCount, reason);
    this.saveSession("completed", reason);
    // Show a toast so the user knows the agent has finished — import lazily
    // to avoid pulling the DOM module into non-content-script contexts.
    import("../content/agent/execution")
      .then(({ showAgentMessage }) => {
        const isSuccess = /complete|confirm|success|done/i.test(reason);
        showAgentMessage(
          `🤖 Agent finished: ${reason}`,
          isSuccess ? "success" : "info",
          7000,
        );
      })
      .catch(() => {});
  }

  private recordStep(action: string, selector: string, success: boolean): void {
    this.stepCount++;
    const step: AgentStep = {
      stepNumber: this.stepCount,
      action,
      selector,
      timestamp: Date.now(),
      success,
      pageUrl: window.location.href,
    };
    this.steps.push(step);
    this.callbacks.onStepComplete(step);
    this.callbacks.onStatusChange(this.status, this.stepCount);
  }

  /**
   * Waits until the DOM has been quiet (no mutations) for `settleTimeMs`,
   * or a maximum timeout of settleTimeMs + 3000ms, whichever comes first.
   */
  private waitForSettle(): Promise<void> {
    return new Promise((resolve) => {
      let settleTimer: ReturnType<typeof setTimeout>;
      const maxTimeout = this.config.settleTimeMs + 3000;

      const done = () => {
        observer.disconnect();
        clearTimeout(settleTimer);
        clearTimeout(maxTimer);
        resolve();
      };

      const observer = new MutationObserver(() => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, this.config.settleTimeMs);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // Initial timer — if no mutations happen, resolve after settleTimeMs
      settleTimer = setTimeout(done, this.config.settleTimeMs);

      // Hard ceiling so we never wait forever
      const maxTimer = setTimeout(done, maxTimeout);

      // Abort support
      this.abortController?.signal.addEventListener("abort", done, {
        once: true,
      });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Generates a stable identifier for a form element so we can track fills. */
  private formIdentifier(form: HTMLFormElement): string {
    if (form.id) return `#${form.id}`;
    if (form.name) return `[name="${form.name}"]`;
    if (form.action) return form.action;
    return `form[${Array.from(document.querySelectorAll("form")).indexOf(form)}]`;
  }
}
