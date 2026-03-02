/**
 * Autonomous Agent Executor
 *
 * Implements an observe → think → act → wait loop that drives autonomous
 * web interaction based on a user-defined mission prompt.
 *
 * The executor is decoupled from the DOM and AI providers — it receives
 * all dependencies via callbacks so it can be tested and reused easily.
 */

import type { PredictionResult, RankedPrediction } from "./predictionEngine";
import type { FormFieldInfo } from "@/types/ai";

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
  maxAIQueries: 10,
  minConfidence: 0.1,
  stepDelayMs: 2000,
  settleTimeMs: 1500,
  autoFillForms: true,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus =
  | "idle"
  | "planning"
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
  steps: AgentStep[];
  finalMessage?: string;
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
  /**
   * Optional: called once before execution starts.
   * Should return a plain-text plan the AI produced for this mission.
   * @param mission The user's mission/goal string.
   */
  planMission?: (mission: string) => Promise<{ plan: string; estimatedSteps?: number }>;
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

  // Track visited url+selector pairs to avoid infinite link-clicking loops
  private visitedActions = new Set<string>();

  constructor(callbacks: AgentCallbacks, config?: Partial<AgentConfig>) {
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start(mission = ""): Promise<void> {
    if (this.status === "running" || this.status === "planning") return;
    this.reset();

    // Initialise session record
    this.session = {
      id: `agent_${Date.now()}`,
      mission,
      startUrl: window.location.href,
      startTime: Date.now(),
      status: "planning",
      steps: this.steps,
    };

    // ── Planning phase ────────────────────────────────────────────────────
    if (this.callbacks.planMission) {
      this.status = "planning";
      this.callbacks.onStatusChange("planning", 0, "Thinking about the task…");
      try {
        const { plan, estimatedSteps } = await this.callbacks.planMission(mission);
        if (this.status !== "planning") return; // stopped during planning
        this.session.plan = plan;
        this.session.estimatedSteps = estimatedSteps;
        this.callbacks.onStatusChange("planning", 0, `Plan ready (${estimatedSteps ?? "?"} steps)`);
      } catch (err) {
        console.warn("[AgentExecutor] Planning failed, continuing without plan:", err);
      }
    }

    if ((this.status as AgentStatus) === "stopped") return;

    this.status = "running";
    this.abortController = new AbortController();
    this.callbacks.onStatusChange("running", 0, "Agent started");
    try {
      await this.loop();
    } catch (err) {
      // status may have been changed to "stopped" by stop() during the loop
      if ((this.status as AgentStatus) !== "stopped") {
        this.status = "error";
        this.callbacks.onStatusChange(
          "error",
          this.stepCount,
          String(err),
        );
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
    this.callbacks.onStatusChange("paused", this.stepCount, "Agent paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
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

  updateConfig(partial: Partial<AgentConfig>): void {
    Object.assign(this.config, partial);
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
        this.finish(
          `AI query limit reached (${this.config.maxAIQueries})`,
        );
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
        this.finish("No actionable elements found");
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

      // 6. Skip already-visited url+selector combinations to break navigation loops
      const actionKey = `${window.location.href}::${topPrediction.action.selector}`;
      if (this.visitedActions.has(actionKey)) {
        // Try the next-best unvisited prediction
        const freshPred = result.topThree.find(
          (p) => !this.visitedActions.has(`${window.location.href}::${p.action.selector}`),
        );
        if (!freshPred) {
          this.finish("All candidate actions on this page already visited");
          break;
        }
        // Use it instead
        const freshKey = `${window.location.href}::${freshPred.action.selector}`;
        this.visitedActions.add(freshKey);
        this.lastSelector = freshPred.action.selector;
        this.stuckCounter = 0;
        const freshSuccess = await this.callbacks.execute(freshPred);
        this.recordStep(freshPred.action.label, freshPred.action.selector, freshSuccess);
        continue;
      }
      this.visitedActions.add(actionKey);

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

      // 8. Execute
      const success = await this.callbacks.execute(topPrediction);
      this.recordStep(
        topPrediction.action.label,
        topPrediction.action.selector,
        success,
      );

      if (!success) {
        this.stuckCounter++;
        if (this.stuckCounter >= AgentExecutor.MAX_STUCK) {
          this.finish("Cannot find target elements to click");
          break;
        }
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

  private saveSession(status: AgentStatus, finalMessage?: string): void {
    if (!this.session) return;
    this.session.endTime = Date.now();
    this.session.status = status;
    this.session.steps = [...this.steps];
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
    this.stuckCounter = 0;
    this.lastSelector = "";
    this.aiQueryCount = 0;
    this.filledFormSelectors.clear();
    this.visitedActions.clear();
  }

  private finish(reason: string): void {
    this.status = "completed";
    this.callbacks.onStatusChange("completed", this.stepCount, reason);
    this.saveSession("completed", reason);
  }

  private recordStep(
    action: string,
    selector: string,
    success: boolean,
  ): void {
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
