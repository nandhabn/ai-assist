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
import { state } from "../state";
import { getAIProvider } from "../ai/providers";
import { buildAgentToolPrompt } from "@/config/prompts";
import { getEnabledSkills } from "@/utils/skillsStorage";

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
  prompt: string;
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
      newElements.push(key.replace(/^[^:]+:/, ""));
    }
  });
  prev.elementKeys.forEach((key) => {
    if (!current.elementKeys.has(key)) {
      removedElements.push(key.replace(/^[^:]+:/, ""));
    }
  });

  // Consume the failure reason written by executeForAgent (if any)
  const failureReason = state.lastActionFailure ?? undefined;
  state.lastActionFailure = null;

  return {
    urlChanged: current.url !== prev.url,
    titleChanged: current.title !== prev.title,
    previousUrl: prev.url,
    newElements: newElements.slice(0, 20),
    removedElements: removedElements.slice(0, 20),
    ...(failureReason ? { failureReason } : {}),
  };
}

// ─── Page snapshot ─────────────────────────────────────────────────────────────

/**
 * Collects all visible interactive elements on the page.
 * Includes current typed/selected values for inputs so the AI knows what
 * is already filled in.
 *
 * Elements are sorted by relevance so the most actionable items for the
 * current context (e.g. sidebar/panel buttons that just appeared) come
 * first in the list sent to the AI.
 */
export function buildPageElements(): AgentPageElement[] {
  /** Track both the DOM node and the item so we can sort on the node. */
  const collected: { el: HTMLElement; item: AgentPageElement }[] = [];
  const seen = new Set<string>();

  const add = (el: HTMLElement, label: string, type: AgentPageElement["type"], currentValue?: string) => {
    const key = `${type}:${label}`;
    if (!label || label.length < 2 || seen.has(key)) return;
    seen.add(key);
    collected.push({ el, item: { label, type, ...(currentValue ? { currentValue } : {}) } });
  };

  // Shared helper: strip price/currency/rating noise that appears when an element's
  // textContent concatenates multiple child text nodes (e.g. product cards).
  // e.g. "iPhone 17 Pro₹1,34,900Reliance Digital" → "iPhone 17 Pro"
  // e.g. "Add to cart 12999" stays "Add to cart" (4+ digit cut)
  // but: "iPhone 17 Pro" is left intact (short model number kept)
  const cleanLabel = (s: string): string =>
    s
      .replace(/[\u20a8\u20b9$£€¥].*/, "")         // cut at any currency symbol
      .replace(/\d{4,}[\d,]*(\.\d+)?.*/, "")        // cut at 4+ digit price runs
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 60);

  // Returns the first non-empty text node inside an element (avoids concatenation noise).
  const firstTextNode = (el: HTMLElement): string => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = (node.textContent ?? "").trim();
      if (t.length >= 2) return t;
    }
    return "";
  };

  // Safe string coercion: always returns a plain string regardless of what the
  // DOM property actually contains (e.g. SVGAnimatedString, number on <meter>).
  const safeStr = (v: unknown): string => (typeof v === "string" ? v : "");

  // Buttons — use aria-label or first text node + clean() to avoid product-card
  // concatenation noise (e.g. "iPhone 17₹81,900Imagine Apple…" on [role="button"] cards).
  document
    .querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"]',
    )
    .forEach((el) => {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return;
        if (parseFloat(style.opacity) < 0.1) return;

        const ariaLabel = el.getAttribute("aria-label")?.trim() ?? "";
        const testId = el.getAttribute("data-testid")?.trim() ?? "";
        // safeStr guards against non-string .value (e.g. numeric on <meter>/<progress>,
        // SVGAnimatedString on SVG elements, or custom-element getter overrides).
        const inputVal = safeStr((el as HTMLInputElement).value).trim();

        const label =
          (ariaLabel.length > 0 && ariaLabel.length <= 60 ? cleanLabel(ariaLabel) : "") ||
          inputVal.slice(0, 60) ||
          cleanLabel(firstTextNode(el)) ||
          cleanLabel(el.getAttribute("title")?.trim() ?? "") ||
          (testId.length > 0 && testId.length <= 60 ? testId : "") ||
          "";

        add(el, label, "button");
      } catch { /* skip element on any unexpected DOM property access */ }
    });

  // Links — extract the first clean text node to avoid concatenated price/rating/store
  // noise that appears in shopping cards (e.g. "iPhone 17 Pro₹1,34,900Reliance Digital…").
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((el) => {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

      const ariaLabel = el.getAttribute("aria-label")?.trim() ?? "";

      const label =
        (ariaLabel.length > 0 && ariaLabel.length <= 60 ? cleanLabel(ariaLabel) : "") ||
        cleanLabel(firstTextNode(el)) ||
        el.getAttribute("title")?.trim().slice(0, 40) ||
        "";

      add(el, label, "link");
    } catch { /* skip */ }
  });

  // Text inputs — label priority: associated <label> → aria-label → placeholder → name
  document
    .querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button])",
    )
    .forEach((el) => {
      try {
        const labelFromDom = el.id
          ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)?.textContent?.trim() ?? ""
          : "";
        const label = String(
          labelFromDom ||
          el.getAttribute("aria-label") ||
          el.getAttribute("data-testid") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.getAttribute("name") ||
          ""
        )
          .trim()
          .slice(0, 80);
        add(el, label || `input[${el.type}]`, "input", safeStr(el.value) || undefined);
      } catch { /* skip */ }
    });

  // Textareas
  document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el) => {
    try {
      const label = String(
        el.getAttribute("aria-label") ??
        el.getAttribute("data-testid") ??
        el.getAttribute("placeholder") ??
        "textarea"
      )
        .trim()
        .slice(0, 80);
      add(el, label, "textarea", safeStr(el.value) || undefined);
    } catch { /* skip */ }
  });

  // Selects
  document.querySelectorAll<HTMLSelectElement>("select").forEach((el) => {
    try {
      const labelEl = el.id
        ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
        : null;
      const label = String(
        el.getAttribute("aria-label") ??
        el.getAttribute("data-testid") ??
        labelEl?.textContent ??
        el.getAttribute("name") ??
        "select"
      )
        .trim()
        .slice(0, 80);
      const currentValue = safeStr(el.options[el.selectedIndex]?.text).trim() || undefined;
      add(el, label, "select", currentValue);
    } catch { /* skip */ }
  });

  // Contenteditable divs (e.g. tweet composer, rich text editors)
  document.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='']").forEach((el) => {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
      const label = String(
        el.getAttribute("aria-label") ??
        el.getAttribute("data-testid") ??
        el.getAttribute("placeholder") ??
        el.getAttribute("title") ??
        "rich text editor"
      )
        .trim()
        .slice(0, 80);
      add(el, label, "textarea", el.textContent?.trim().slice(0, 60) || undefined);
    } catch { /* skip */ }
  });

  // ── Sort by relevance so the AI always sees the most actionable items ────────
  //
  // Priority tiers:
  //   0 — inside an active panel / dialog / drawer (e.g. Google Shopping sidebar)
  //   1 — shopping-relevant label anywhere (buy, cart, checkout, visit site, …)
  //   2 — inside the visible viewport
  //   3 — everything else
  //
  // This ensures buttons like "Visit site" or "Buy" inside a sidebar that just
  // opened are ranked first even if they appear late in DOM order.

  const SHOPPING_RE = /\b(buy|cart|purchase|checkout|add to|order|visit site|proceed|pay|place order)\b/i;
  const PANEL_SELECTOR = '[role="dialog"], [role="complementary"], [role="alertdialog"], aside, [aria-modal="true"]';
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const tier = (el: HTMLElement, label: string): number => {
    if (el.closest(PANEL_SELECTOR)) return 0;
    if (SHOPPING_RE.test(label)) return 1;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw) return 2;
    return 3;
  };

  collected.sort((a, b) => tier(a.el, a.item.label) - tier(b.el, b.item.label));

  return collected.slice(0, 80).map((c) => c.item);
}

/**
 * Extracts key visible page text (headings, prices, short descriptions) that
 * interactive-element labels alone don't capture. This gives the AI price
 * context, product names, and page structure without sending the full DOM.
 */
export function buildPageText(): string {
  const parts: string[] = [];

  // Headings give strong structural context
  document.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((el) => {
    const t = el.textContent?.trim();
    if (t && t.length > 2) parts.push(t.slice(0, 120));
  });

  // Visible price / currency values — leaf text nodes only to avoid duplicates
  const CURRENCY_RE = /[\u20a8\u20b9$£€¥]/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = (node.textContent ?? "").trim();
    if (!t || t.length < 2 || t.length > 60) continue;
    if (!CURRENCY_RE.test(t)) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") continue;
    parts.push(t);
  }

  // Dedupe and cap
  return [...new Set(parts)].slice(0, 25).join(" | ");
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
  if (state.aiProvider === undefined) state.aiProvider = await getAIProvider();

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
    pageText: buildPageText(),
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
      // Use the AI-reported plan step (stored on session) rather than total tool-call count,
      // since multiple tool calls may be needed per plan step.
      const estimatedSteps = session.estimatedSteps ?? 99;
      context.currentPlanStep = Math.min(session.currentPlanStep ?? 1, estimatedSteps);
    }
  }

  // Load enabled skills and attach to context so the prompt can inject them
  context.skills = await getEnabledSkills();

  const prompt = buildAgentToolPrompt(context);

  let toolCall;
  try {
    toolCall = await state.aiProvider.callAgentTool(context);
  } catch (err) {
    console.error("[Agent] callAgentTool failed:", err);
    throw err;
  }

  // If the AI chose a skill tool, resolve it to its step sequence so
  // executeAgentToolCall can run them without knowing about skills.
  if (toolCall.tool && !(["navigate","click","type","scroll","message","done"] as string[]).includes(toolCall.tool)) {
    const allSkillTools = (context.skills ?? []).flatMap((s) => s.tools ?? []);
    const skillTool = allSkillTools.find((t) => t.name === toolCall.tool);
    if (skillTool) {
      toolCall.skillSteps = skillTool.steps;
      console.log(`[Agent] Resolved skill tool "${toolCall.tool}" → ${skillTool.steps.length} steps`);
    } else {
      console.warn(`[Agent] Unknown tool "${toolCall.tool}" — not a built-in and not found in any skill`);
    }
  }

  // Store context for agentManager to record the full turn after execution
  if (toolCall.tool !== "done") {
    _lastPredictionContext = {
      pageElements: context.pageElements ?? [],
      toolCall,
      observation: postActionObservation,
      pageUrl: window.location.href,
      pageTitle: document.title,
      prompt,
    };
  }

  if (toolCall.tool === "done") {
    console.log(`[Agent] done — ${toolCall.params.reason ?? "mission complete"}`);
    return { topThree: [], confidence: 0, isDone: true, doneReason: toolCall.params.reason ?? "Mission complete" };
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
