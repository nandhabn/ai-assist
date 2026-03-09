/**
 * Agent step decider.
 *
 * Collects a rich page snapshot, asks the AI exactly what to do for the
 * current mission step via callAgentTool(), and returns the result as a
 * single structured tool-call prediction.
 *
 * No scoring, no fallbacks, no label-matching — the AI decides.
 */

import type { AgentPageElement, CompactContext, PostActionObservation } from "@/types/ai";
import type { PredictionResult } from "@/utils/predictionEngine";
import { state } from "./state";
import { getAIProvider } from "./providers";

// ─── Pre-action snapshot (for post-action DOM diff) ────────────────────────────

interface PageSnapshot {
  url: string;
  title: string;
  /** Set of "type:label" keys for every interactive element visible at snapshot time. */
  elementKeys: Set<string>;
}

/** Snapshot taken just before the most recent AI prediction was fired. */
let _preActionSnapshot: PageSnapshot | null = null;

/**
 * Set after every successful callAgentTool() call.
 * Consumed by agentManager's onStepComplete to build a full AgentTurn record.
 */
let _lastPredictionContext: {
  pageElements: import("@/types/ai").AgentPageElement[];
  toolCall: import("@/types/ai").AgentToolCall;
  observation: import("@/types/ai").PostActionObservation | null;
  pageUrl: string;
  pageTitle: string;
} | null = null;

export function consumeLastPredictionContext() {
  const ctx = _lastPredictionContext;
  _lastPredictionContext = null;
  return ctx;
}

/** Capture the current DOM state so we can diff it on the NEXT predict call. */
function captureSnapshot(): PageSnapshot {
  const elements = buildPageElements();
  return {
    url: window.location.href,
    title: document.title,
    elementKeys: new Set(elements.map((e) => `${e.type}:${e.label}`)),
  };
}

/**
 * Diffs the stored pre-action snapshot against the current DOM and returns a
 * structured observation that tells the AI what concretely changed.
 * Returns null on the very first step (no previous snapshot yet).
 */
function buildPostActionObservation(): PostActionObservation | null {
  if (!_preActionSnapshot) return null;

  const current = captureSnapshot();
  const prev = _preActionSnapshot;

  const newElements: string[] = [];
  const removedElements: string[] = [];

  current.elementKeys.forEach((key) => {
    if (!prev.elementKeys.has(key)) {
      // Extract just the label part (strip the "type:" prefix)
      newElements.push(key.replace(/^[^:]+:/, ""));
    }
  });
  prev.elementKeys.forEach((key) => {
    if (!current.elementKeys.has(key)) {
      removedElements.push(key.replace(/^[^:]+:/, ""));
    }
  });

  return {
    urlChanged: current.url !== prev.url,
    titleChanged: current.title !== prev.title,
    previousUrl: prev.url,
    newElements: newElements.slice(0, 20),
    removedElements: removedElements.slice(0, 20),
  };
}

// ─── Page snapshot ─────────────────────────────────────────────────────────────

/**
 * Collects all visible interactive elements on the page.
 * Includes current typed/selected values for inputs so the AI knows what
 * is already filled in.
 */
export function buildPageElements(): AgentPageElement[] {
  const results: AgentPageElement[] = [];
  const seen = new Set<string>();

  const add = (label: string, type: AgentPageElement["type"], currentValue?: string) => {
    const key = `${type}:${label}`;
    if (!label || label.length < 2 || seen.has(key)) return;
    seen.add(key);
    results.push({ label, type, ...(currentValue ? { currentValue } : {}) });
  };

  // Buttons
  document
    .querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"]',
    )
    .forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80);
      add(label, "button");
    });

  // Links — extract the first clean text node to avoid concatenated price/rating/store
  // noise that appears in shopping cards (e.g. "iPhone 17 Pro₹1,34,900Reliance Digital…").
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

    // Prefer aria-label when it's concise (≤60 chars).
    const ariaLabel = el.getAttribute("aria-label")?.trim() ?? "";

    // Find the first non-empty direct or shallow text node.
    let firstText = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = (node.textContent ?? "").trim();
      if (t.length >= 2) { firstText = t; break; }
    }

    // Strip trailing price/currency/rating noise from whatever we got:
    // e.g. "iPhone 17₹1,34,900" → "iPhone 17"
    const clean = (s: string) =>
      s
        .replace(/[\u20a8\u20b9$£€¥].*/, "")   // cut at any currency symbol
        .replace(/\d[\d,]+(\.\d+)?.*/, "")       // cut at price-like number
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 40);

    const label =
      (ariaLabel.length > 0 && ariaLabel.length <= 60 ? clean(ariaLabel) : "") ||
      clean(firstText) ||
      el.title?.trim().slice(0, 40) ||
      "";

    add(label, "link");
  });

  // Text inputs — label priority: associated <label> → aria-label → placeholder → name
  // Checking <label> first avoids exposing noisy aria-labels like "Search by voice"
  // that belong to a nearby button, not the input itself.
  document
    .querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button])",
    )
    .forEach((el) => {
      const labelFromDom = el.id
        ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)?.textContent?.trim() ?? ""
        : "";
      const label = (
        labelFromDom ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("name") ||
        ""
      )
        .trim()
        .slice(0, 80);
      add(label || `input[${el.type}]`, "input", el.value || undefined);
    });

  // Textareas
  document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el) => {
    const label = (el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "textarea")
      .trim()
      .slice(0, 80);
    add(label, "textarea", el.value || undefined);
  });

  // Selects
  document.querySelectorAll<HTMLSelectElement>("select").forEach((el) => {
    const labelEl = el.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
      : null;
    const label = (el.getAttribute("aria-label") ?? labelEl?.textContent ?? el.name ?? "select")
      .trim()
      .slice(0, 80);
    const currentValue = el.options[el.selectedIndex]?.text?.trim();
    add(label, "select", currentValue || undefined);
  });

  return results.slice(0, 40);
}

// ─── Step decider ──────────────────────────────────────────────────────────────

/**
 * Asks the AI what single action to perform for the current agent step.
 *
 * Flow:
 *   1. Build a rich page snapshot (URL, title, all interactive elements + current values).
 *   2. Attach step history and plan if an executor session exists.
 *   3. Call provider.callAgentTool() → structured AgentToolCall.
 *   4. Wrap it in a PredictionResult using the __tool__: sentinel so
 *      executeForAgent() can dispatch it without any DOM label-matching.
 */
export async function predictForAgent(): Promise<PredictionResult> {
  if (state.aiProvider === undefined) state.aiProvider = getAIProvider();

  if (!state.aiProvider?.callAgentTool) {
    console.error("[Agent] No AI provider with callAgentTool support — cannot continue.");
    return { topThree: [], confidence: 0 };
  }

  // ── DOM re-evaluation ────────────────────────────────────────────────────
  // 1. Diff current DOM against the snapshot taken before the last action.
  const postActionObservation = buildPostActionObservation();
  // 2. Capture a fresh snapshot for the NEXT prediction's diff.
  _preActionSnapshot = captureSnapshot();

  if (postActionObservation) {
    const { urlChanged, newElements, removedElements } = postActionObservation;
    console.log(
      `[Agent] DOM re-evaluated — URL changed: ${urlChanged} | +${newElements.length} new elements | -${removedElements.length} removed elements`,
    );
  }
  // ── end DOM re-evaluation ─────────────────────────────────────────────────

  const context: CompactContext = {
    pageIntent: document.title || window.location.pathname,
    topVisibleActions: [],
    formFields: [],
    pageMeta: {
      url: window.location.href,
      title: document.title,
      description:
        (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)
          ?.content ?? "",
      ogType: "",
      ogSiteName: "",
      keywords: "",
      canonical:
        (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)
          ?.href ?? "",
    },
    mission: state.currentMission || undefined,
    currentUrl: window.location.href,
    pageElements: buildPageElements(),
    postActionObservation: postActionObservation ?? undefined,
  };

  // Attach step history and plan from the running executor session
  if (state.agentExecutor) {
    const session = state.agentExecutor.getSession();
    context.stepHistory = state.agentExecutor.getSteps().map((s) => ({
      action: s.action,
      pageUrl: s.pageUrl,
    }));
    // Full turn history for rich context — limited to last 10 turns to keep
    // prompt size manageable while still giving the AI a meaningful memory.
    const allTurns = state.agentExecutor.getTurns();
    if (allTurns.length > 0) {
      context.turnHistory = allTurns.slice(-10) as import("@/types/ai").AgentTurn[];
    }
    if (session?.plan) {
      context.plan = session.plan;
      const completedSteps = state.agentExecutor.getStepCount();
      const estimatedSteps = session.estimatedSteps ?? 99;
      context.currentPlanStep = Math.min(completedSteps + 1, estimatedSteps);
    }
  }

  let toolCall;
  try {
    toolCall = await state.aiProvider.callAgentTool(context);
  } catch (err) {
    console.error("[Agent] callAgentTool failed:", err);
    throw err;
  }

  // Store context for agentManager to record the full turn after execution
  if (toolCall.tool !== "done") {
    _lastPredictionContext = {
      pageElements: context.pageElements ?? [],
      toolCall,
      observation: postActionObservation,
      pageUrl: window.location.href,
      pageTitle: document.title,
    };
  }

  if (toolCall.tool === "done") {
    console.log(`[Agent] done — ${toolCall.params.reason ?? "mission complete"}`);
    return { topThree: [], confidence: 0 };
  }

  const score = toolCall.confidenceEstimate ?? 0.8;
  const nb = {
    proximityScore: 0.5,
    intentScore: 0.5,
    formScore: 0.5,
    roleScore: 0.5,
    directionScore: 0.5,
  };

  return {
    topThree: [
      {
        action: {
          label: `[${toolCall.tool}] ${JSON.stringify(toolCall.params)}`,
          selector: `__tool__:${JSON.stringify(toolCall)}`,
          role: "primary" as const,
          boundingBox: new DOMRect(),
          confidenceScore: score,
        },
        totalScore: score,
        breakdown: nb,
        inputText: toolCall.params.text,
      },
    ],
    confidence: score,
  };
}
