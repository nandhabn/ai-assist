/**
 * @file Prediction Engine and Form Filling Module
 * @description Provides dual functionality:
 * 1. Ranks potential user actions based on page context (Prediction Engine).
 * 2. Safely and intelligently fills web forms (Form-Filling Module).
 * @architecture This module is designed for the content script layer. It directly interacts
 * with the DOM.
 */

// --- COMMON TYPE DEFINITIONS ---
// Exported for use in other modules like `content.ts`.

/**
 * Represents a clickable or interactive element on the page.
 */
export interface ActionCandidate {
  label: string;
  selector: string; // Stable CSS selector
  role: "primary" | "secondary" | "link" | "unknown";
  boundingBox: DOMRect;
  confidenceScore: number; // Base confidence from the context builder
  formSelector?: string; // CSS selector of the parent form, if any
}

/**
 * Represents a form on the page.
 */
export interface Form {
  selector: string;
  completionScore: number; // 0 to 1
  fields: { name: string; type: string; value: unknown }[]; // Privacy-safe, no values
}

/**
 * Represents a user interaction.
 */
export interface UserAction {
  type: "click" | "input" | "submit" | "focus";
  selector: string | { css: string; xpath?: string }; // Can be string or object with css/xpath
  formSelector?: string; // CSS selector of the parent form, if any
  elementMetadata?: {
    parentForm?: string;
    parentFormIndex?: number;
  };
}

/**
 * The full context of the page at a given moment for prediction.
 */
export interface PageContext {
  pageIntent: string; // e.g., 'authentication', 'search', 'checkout', 'navigation'
  visibleActions: ActionCandidate[];
  forms: Form[];
  lastUserAction: UserAction | null;
  lastActionRect: DOMRect | null;
  viewport: {
    width: number;
    height: number;
  };
  /** User-defined mission prompt, if set. */
  mission?: string;
}

/**
 * The detailed breakdown of a prediction's score.
 */
export interface ScoreBreakdown {
  proximityScore: number;
  intentScore: number;
  formScore: number;
  roleScore: number;
  directionScore: number;
}

/**
 * An action candidate with its calculated rank and score.
 */
export interface RankedPrediction {
  action: ActionCandidate;
  totalScore: number;
  breakdown: ScoreBreakdown;
  /**
   * Text to type into the target element — populated by AI for input/search actions.
   * Undefined for click/navigation actions.
   */
  inputText?: string;
}

/**
 * The final output of the prediction engine.
 */
export interface PredictionResult {
  topThree: RankedPrediction[];
  confidence: number; // Overall confidence (topScore - secondScore)
}

// ===================================================================================
// --- PREDICTION ENGINE MODULE ---
// Re-instated to fix build errors from `content.ts`.
// ===================================================================================

const WEIGHTS = {
  PROXIMITY: 0.3,
  INTENT: 0.25,
  FORM: 0.25,
  ROLE: 0.1,
  DIRECTION: 0.1,
};

const NEUTRAL_SCORE = 0.5;

const getCenter = (rect: DOMRect): { x: number; y: number } => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

function calculateProximityScore(
  lastActionRect: DOMRect | null,
  candidateBoundingBox: DOMRect,
  viewport: { width: number; height: number },
): number {
  if (!lastActionRect) return NEUTRAL_SCORE;
  const lastActionCenter = getCenter(lastActionRect);
  const candidateCenter = getCenter(candidateBoundingBox);
  const distance = Math.sqrt(
    Math.pow(lastActionCenter.x - candidateCenter.x, 2) +
      Math.pow(lastActionCenter.y - candidateCenter.y, 2),
  );
  const viewportDiagonal = Math.sqrt(
    Math.pow(viewport.width, 2) + Math.pow(viewport.height, 2),
  );
  if (viewportDiagonal === 0) return NEUTRAL_SCORE;
  const normalizedDistance = Math.min(distance / viewportDiagonal, 1.0);
  return Math.max(0, Math.min(1.0 - normalizedDistance, 1));
}

function calculateIntentScore(
  pageIntent: string,
  candidate: ActionCandidate,
): number {
  const label = candidate.label.toLowerCase();
  switch (pageIntent) {
    case "authentication":
      if (
        candidate.role === "primary" &&
        (label.includes("login") ||
          label.includes("sign in") ||
          label.includes("submit"))
      )
        return 1.0;
      if (candidate.selector.includes("password")) return 0.8;
      return 0.4;
    case "search":
      if (
        candidate.role === "primary" &&
        (label.includes("search") ||
          candidate.selector.includes('[type="submit"]'))
      )
        return 1.0;
      if (label.includes("filter") || label.includes("sort")) return 0.8;
      if (candidate.selector.includes("search")) return 0.9;
      return 0.5;
    case "checkout":
      if (
        candidate.role === "primary" &&
        (label.includes("continue") ||
          label.includes("submit") ||
          label.includes("pay") ||
          label.includes("checkout"))
      )
        return 1.0;
      if (
        label.includes("cart") ||
        label.includes("address") ||
        label.includes("payment")
      )
        return 0.8;
      return 0.5;
    case "navigation":
      if (candidate.role === "primary" || candidate.role === "link") return 0.8;
      return 0.4;
    default:
      return NEUTRAL_SCORE;
  }
}

function calculateFormScore(
  lastUserAction: UserAction | null,
  candidate: ActionCandidate,
): number {
  if (!lastUserAction?.formSelector) return NEUTRAL_SCORE;
  if (candidate.formSelector) {
    return candidate.formSelector === lastUserAction.formSelector ? 0.9 : 0.2;
  }
  return 0.4;
}

function calculateRoleScore(role: ActionCandidate["role"]): number {
  const scores = { primary: 1.0, secondary: 0.7, link: 0.5, unknown: 0.3 };
  return scores[role] || 0.3;
}

function calculateDirectionScore(
  lastActionRect: DOMRect | null,
  candidateBoundingBox: DOMRect,
  viewport: { width: number; height: number },
): number {
  if (!lastActionRect) return NEUTRAL_SCORE;
  let score = NEUTRAL_SCORE;
  const verticalDelta = candidateBoundingBox.top - lastActionRect.bottom;
  if (verticalDelta > 0) {
    score += 0.4 * (1.0 - Math.min(verticalDelta / viewport.height, 1.0));
  } else if (candidateBoundingBox.bottom < lastActionRect.top) {
    score -= 0.15;
  }
  const horizontalDelta = candidateBoundingBox.left - lastActionRect.left;
  if (horizontalDelta > 0) {
    score += 0.1 * (1.0 - Math.min(horizontalDelta / viewport.width, 1.0));
  }
  return Math.max(0.3, Math.min(score, 1.0));
}

function isLikelySubmitAction(candidate: ActionCandidate): boolean {
  const selector = candidate.selector.toLowerCase();
  const label = candidate.label.toLowerCase();
  if (selector.includes('[type="submit"]')) return true;
  const submitKeywords = ["log in", "sign in", "submit"];
  if (submitKeywords.some((keyword) => label.includes(keyword))) return true;
  if (
    selector.includes('[name="login"]') ||
    selector.includes('[data-testid*="login"]') ||
    selector.includes('[data-testid*="submit"]')
  )
    return true;
  return false;
}

/**
 * Ranks visible action candidates based on a weighted scoring model.
 */
export function generatePredictions(context: PageContext): PredictionResult {
  const {
    visibleActions,
    lastActionRect,
    pageIntent,
    lastUserAction,
    viewport,
  } = context;
  if (!visibleActions || visibleActions.length === 0)
    return { topThree: [], confidence: 0 };

  const rankedCandidates: RankedPrediction[] = visibleActions.map((action) => {
    const breakdown: ScoreBreakdown = {
      proximityScore: calculateProximityScore(
        lastActionRect,
        action.boundingBox,
        viewport,
      ),
      intentScore: calculateIntentScore(pageIntent, action),
      formScore: calculateFormScore(lastUserAction, action),
      roleScore: calculateRoleScore(action.role),
      directionScore: calculateDirectionScore(
        lastActionRect,
        action.boundingBox,
        viewport,
      ),
    };

    let totalScore =
      breakdown.proximityScore * WEIGHTS.PROXIMITY +
      breakdown.intentScore * WEIGHTS.INTENT +
      breakdown.formScore * WEIGHTS.FORM +
      breakdown.roleScore * WEIGHTS.ROLE +
      breakdown.directionScore * WEIGHTS.DIRECTION;

    if (
      lastUserAction?.formSelector &&
      action.formSelector === lastUserAction.formSelector
    ) {
      if (isLikelySubmitAction(action)) totalScore *= 1.35;
      else if (
        action.role === "link" ||
        action.label.toLowerCase().includes("forgot")
      )
        totalScore *= 0.85;
      else totalScore *= 1.05;
    } else if (lastUserAction?.formSelector && action.formSelector) {
      totalScore *= 0.75;
    }

    return { action, totalScore, breakdown };
  });

  rankedCandidates.sort((a, b) => b.totalScore - a.totalScore);
  const topThree = rankedCandidates.slice(0, 3);
  let confidence = 0;
  if (topThree.length > 0 && topThree[0].totalScore > 0) {
    const topScore = topThree[0].totalScore;
    confidence =
      topThree.length > 1 ? (topScore - topThree[1].totalScore) / topScore : 1;
  }

  return { topThree, confidence: Math.max(0, Math.min(confidence, 1)) };
}

import {
  AIProvider,
  CompactContext,
  AIPrediction,
  PageMeta,
} from "../types/ai";

// ===================================================================================
// --- PAGE META EXTRACTION ---
// ===================================================================================

/**
 * Extracts key metadata from the current page's <head> element.
 * Reads meta description, Open Graph, Twitter Card, and canonical data.
 * Designed to be cheap — only queries selectors once.
 */
function extractPageMeta(): PageMeta {
  const getMeta = (selectors: string[]): string => {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const val =
            el.getAttribute("content") || el.getAttribute("href") || "";
          if (val.trim()) return val.trim();
        }
      } catch (_) {}
    }
    return "";
  };

  return {
    url: window.location.href,
    title: document.title || "",
    description: getMeta([
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ]),
    ogType: getMeta(['meta[property="og:type"]', 'meta[name="twitter:card"]']),
    ogSiteName: getMeta([
      'meta[property="og:site_name"]',
      'meta[name="application-name"]',
    ]),
    keywords: getMeta(['meta[name="keywords"]']),
    canonical: getMeta(['link[rel="canonical"]', 'meta[property="og:url"]']),
  };
}

// ===================================================================================
// --- AI FALLBACK ORCHESTRATOR (v2 - Hardened) ---
// ===================================================================================

let lastAICallTimestamp = 0;
const AI_CALL_RATE_LIMIT = 5000; // Increased to 5 seconds minimum between calls
let consecutiveAIFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3; // Disable AI after 3 consecutive failures

/**
 * Calculates a similarity score between two strings based on token overlap.
 * @param strA The first string (e.g., from an AI prediction).
 * @param strB The second string (e.g., from a DOM element label).
 * @returns A score from 0.0 to 1.0.
 * @private
 */
function calculateSimilarity(strA: string, strB: string): number {
  const normalize = (s: string) => s.toLowerCase().trim().split(/\s+/);
  const tokensA = new Set(normalize(strA));
  const tokensB = new Set(normalize(strB));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));

  // Jaccard similarity
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

/**
 * Converts the detailed PageContext into a compact format suitable for an AI prompt.
 * @param context The full page context.
 * @returns A lightweight, serializable context.
 */
export function createCompactContext(context: PageContext): CompactContext {
  const selector = context.lastUserAction?.selector;
  const lastActionSelector: string | undefined =
    typeof selector === "string"
      ? selector
      : selector && typeof selector === "object" && "css" in selector
        ? selector.css
        : undefined;

  let lastActionLabel: string | undefined = lastActionSelector;
  if (lastActionSelector) {
    const lastAction = context.visibleActions.find(
      (a) => a.selector === lastActionSelector,
    );
    if (lastAction) {
      lastActionLabel = lastAction.label;
    }
  }

  return {
    pageIntent: context.pageIntent,
    lastActionLabel: lastActionLabel,
    // Cap at 20 actions and 80 chars per label to keep the prompt small.
    // The AI only needs a short candidate list to pick from.
    topVisibleActions: context.visibleActions
      .slice(0, 20)
      .map((a) => a.label.length > 80 ? a.label.slice(0, 77) + "..." : a.label),
    formFields: context.forms.flatMap((f) =>
      f.fields.map((field) => field.name),
    ),
    pageMeta: extractPageMeta(),
    mission: context.mission,
  };
}

/**
 * Orchestrates when to use a deterministic prediction vs. an AI-powered prediction.
 * This hardened version includes rate limiting, confidence gating, and semantic matching.
 *
 * @param context The full context of the page.
 * @param deterministicResult The pre-computed result from the deterministic engine.
 * @param aiProvider An instance of an AI provider (e.g., GeminiProvider).
 * @returns A `PredictionResult` that may be augmented with an AI prediction.
 */
export async function maybeUseAI(
  context: PageContext,
  deterministicResult: PredictionResult,
  aiProvider: AIProvider,
): Promise<PredictionResult> {
  const { confidence, topThree } = deterministicResult;

  // 1. High-Confidence Case or No Actions: Trust the deterministic result.
  if (confidence > 0.4 || context.visibleActions.length === 0) {
    return deterministicResult;
  }

  // 2. Rate Limiting Guard: Prevent API spam.
  const now = Date.now();
  if (now - lastAICallTimestamp < AI_CALL_RATE_LIMIT) {
    return deterministicResult;
  }

  // 2a. Disable AI if too many consecutive failures
  if (consecutiveAIFailures >= MAX_CONSECUTIVE_FAILURES) {
    return deterministicResult;
  }

  // 3. Low-Confidence Case: Attempt to fall back to the AI provider.
  if (confidence < 0.2) {
    try {
      lastAICallTimestamp = now; // Update timestamp before the async call
      const compactContext = createCompactContext(context);
      const aiPrediction = await aiProvider.predictNextAction(compactContext);

      // 4. AI Confidence Gate: Only trust confident AI predictions.
      if (aiPrediction.confidenceEstimate <= 0.5) {
        return deterministicResult;
      }

      // 5. Semantic Matching: Find the best matching candidate for the AI's label.
      const candidatesWithSimilarity = context.visibleActions
        .map((action) => ({
          action,
          similarity: calculateSimilarity(
            aiPrediction.predictedActionLabel,
            action.label,
          ),
        }))
        .filter((item) => item.similarity > 0.5); // Similarity Gate

      if (candidatesWithSimilarity.length === 0) {
        return deterministicResult; // No sufficiently similar action found.
      }

      candidatesWithSimilarity.sort((a, b) => b.similarity - a.similarity);
      const bestMatch = candidatesWithSimilarity[0];

      // 6. Principled Score Merging: Convert AI confidence to a score and re-sort.
      const topDeterministicScore = topThree[0]?.totalScore || 0.5;
      const aiScore =
        topDeterministicScore * (0.8 + 0.4 * aiPrediction.confidenceEstimate);

      const aiRankedPrediction: RankedPrediction = {
        action: bestMatch.action,
        totalScore: aiScore,
        breakdown: {
          // -1 indicates an AI-driven score
          proximityScore: -1,
          intentScore: -1,
          formScore: -1,
          roleScore: -1,
          directionScore: -1,
        },
      };

      // Remove the matched action if it's already in the top three to avoid duplicates.
      const finalPredictions = topThree.filter(
        (p) => p.action.selector !== bestMatch.action.selector,
      );
      finalPredictions.push(aiRankedPrediction);
      finalPredictions.sort((a, b) => b.totalScore - a.totalScore);

      // 7. Recalculate Final Result
      const newTopThree = finalPredictions.slice(0, 3);
      const newTopScore = newTopThree[0]?.totalScore || 0;
      const newSecondScore = newTopThree[1]?.totalScore || 0;
      const newConfidence =
        newTopScore > 0 ? (newTopScore - newSecondScore) / newTopScore : 1;

      // Reset failure counter on success
      consecutiveAIFailures = 0;

      return {
        topThree: newTopThree,
        confidence: Math.max(0, Math.min(newConfidence, 1.0)),
      };
    } catch (error: any) {
      consecutiveAIFailures++;

      // Handle quota/rate limit errors more gracefully
      const errorMessage = error?.message || String(error);
      const isQuotaError =
        errorMessage.includes("429") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("insufficient");

      if (isQuotaError) {
        // Only log quota errors once to avoid spam
        if (!(window as any).__aiQuotaErrorLogged) {
          console.warn(
            "[Flow Agent] AI provider quota exceeded. Falling back to deterministic predictions. Autofill still works without AI.",
          );
          (window as any).__aiQuotaErrorLogged = true;
        }
        // Disable AI immediately on quota errors
        consecutiveAIFailures = MAX_CONSECUTIVE_FAILURES;
      } else {
        // Log other errors only if not too many failures
        if (consecutiveAIFailures < MAX_CONSECUTIVE_FAILURES) {
          console.error("AI Fallback failed:", error);
        } else if (consecutiveAIFailures === MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            "[Flow Agent] Too many AI failures. Temporarily disabling AI calls. Using deterministic predictions only.",
          );
        }
      }
      return deterministicResult; // On error, always return the safe deterministic result.
    }
  }

  // 8. Mid-Confidence or No-AI Case: Return original result.
  return deterministicResult;
}

// ===================================================================================
// --- HARDENED FORM-FILLING MODULE ---
// ===================================================================================

interface FillOptions {
  force?: boolean;
  delay?: number;
  debug?: boolean;
}

interface FillReport {
  filled: string[];
  skipped: string[];
  notFound: string[];
  errors: { field: string; message: string; suggestion?: string }[];
}

interface FieldMatch {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  score: number;
}

function getValueSetter(element: HTMLElement): PropertyDescriptor | null {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const proto = Object.getPrototypeOf(element);
    return Object.getOwnPropertyDescriptor(proto, "value") || null;
  }
  return null;
}

function safeSetValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: any,
  options: { force?: boolean } = {},
): { status: "filled" | "skipped" | "error"; suggestion?: string } {
  if (element.disabled) {
    return {
      status: "skipped",
      suggestion:
        "Field is disabled. Enable the field or check form validation rules.",
    };
  }
  if ((element as HTMLInputElement).readOnly) {
    return {
      status: "skipped",
      suggestion:
        "Field is read-only. Check if field should be editable or if it's controlled by another field.",
    };
  }

  const elementType = (element as HTMLInputElement).type?.toLowerCase();

  if (elementType === "checkbox") {
    const checkbox = element as HTMLInputElement;
    const targetState =
      typeof value === "boolean" ? value : value === checkbox.value;
    if (!options.force && checkbox.checked === targetState)
      return { status: "skipped" };
    checkbox.checked = targetState;
    checkbox.dispatchEvent(
      new Event("click", { bubbles: true, cancelable: true }),
    );
    checkbox.dispatchEvent(
      new Event("change", { bubbles: true, cancelable: true }),
    );
    return { status: "filled" };
  }

  if (elementType === "radio") {
    const radio = element as HTMLInputElement;
    const targetState = radio.value === value;
    if (!options.force && radio.checked === targetState)
      return { status: "skipped" };
    if (targetState) {
      radio.click();
      return { status: "filled" };
    }
    return {
      status: "skipped",
      suggestion: `Radio value "${value}" doesn't match. Available values: ${Array.from(
        document.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${radio.name}"]`,
        ),
      )
        .map((r) => r.value)
        .join(", ")}`,
    };
  }

  if (element.nodeName.toLowerCase() === "select") {
    const select = element as HTMLSelectElement;
    if (!options.force && select.value === String(value))
      return { status: "skipped" };
    const optionToSelect = Array.from(select.options).find(
      (opt) => opt.value === String(value) || opt.text === String(value),
    );
    if (optionToSelect) {
      const setter = getValueSetter(select);
      setter?.set
        ? setter.set.call(select, optionToSelect.value)
        : (select.value = optionToSelect.value);
      select.dispatchEvent(
        new Event("change", { bubbles: true, cancelable: true }),
      );
      return { status: "filled" };
    } else {
      const availableOptions = Array.from(select.options)
        .map((opt) => `"${opt.text || opt.value}"`)
        .join(", ");
      return {
        status: "error",
        suggestion: `Value "${value}" not found in dropdown. Available options: ${availableOptions}. Try using one of the option texts or values.`,
      };
    }
  } else {
    const currentValue = (element as HTMLInputElement | HTMLTextAreaElement)
      .value;
    if (!options.force && currentValue && currentValue !== "") {
      return {
        status: "skipped",
        suggestion: "Field already has a value. Use force option to overwrite.",
      };
    }
    if (!options.force && currentValue === String(value))
      return { status: "skipped" };

    // Check for maxLength constraint
    const maxLength = (element as HTMLInputElement).maxLength;
    if (maxLength > 0 && String(value).length > maxLength) {
      return {
        status: "error",
        suggestion: `Value length (${String(value).length}) exceeds maxLength (${maxLength}). Truncate the value or adjust maxLength.`,
      };
    }

    // Check for pattern validation
    const pattern = (element as HTMLInputElement).pattern;
    if (pattern && !new RegExp(pattern).test(String(value))) {
      return {
        status: "error",
        suggestion: `Value doesn't match required pattern: ${pattern}. Adjust the value to match the pattern.`,
      };
    }

    try {
      const setter = getValueSetter(element);
      setter?.set
        ? setter.set.call(element, String(value))
        : ((element as HTMLInputElement | HTMLTextAreaElement).value =
            String(value));

      // Verify the value was set (React/Vue might intercept)
      if (
        (element as HTMLInputElement | HTMLTextAreaElement).value !==
        String(value)
      ) {
        return {
          status: "error",
          suggestion:
            "Value was not set. The field might be controlled by a framework (React/Vue). Try triggering focus/blur events or check if the field uses a controlled component pattern.",
        };
      }

      element.dispatchEvent(
        new Event("input", { bubbles: true, cancelable: true }),
      );
      element.dispatchEvent(
        new Event("change", { bubbles: true, cancelable: true }),
      );
      return { status: "filled" };
    } catch (error) {
      return {
        status: "error",
        suggestion: `Failed to set value: ${error instanceof Error ? error.message : String(error)}. The field might have special validation or be controlled by JavaScript.`,
      };
    }
  }
}

function normalize(str: string | null | undefined): string {
  return (str || "").toLowerCase().replace(/[\s_-]/g, "");
}

function findBestFieldMatch(
  elements: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[],
  key: string,
): FieldMatch | null {
  const normalizedKey = normalize(key);
  let bestMatch: FieldMatch | null = null;

  for (const element of elements) {
    let score = 0;
    const normalizedName = normalize(element.name);
    const normalizedId = normalize(element.id);
    const normalizedPlaceholder = normalize(
      (element as HTMLInputElement).placeholder,
    );
    const normalizedAriaLabel = normalize(element.getAttribute("aria-label"));

    // Get label text (check multiple ways)
    let labelText = "";
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) labelText = normalize(label.textContent || "");
    }
    if (!labelText) {
      const parentLabel = element.closest("label");
      if (parentLabel) labelText = normalize(parentLabel.textContent || "");
    }
    // Also check for label as previous sibling or in parent
    if (!labelText) {
      const prevSibling = element.previousElementSibling;
      if (prevSibling && prevSibling.tagName === "LABEL") {
        labelText = normalize(prevSibling.textContent || "");
      }
    }

    // Exact string matches first (no normalization) - handles "First name", "Last name" etc.
    if (
      key &&
      (element as HTMLInputElement).name &&
      (element as HTMLInputElement).name === key
    )
      score = 1.0;
    else if (key && element.getAttribute("aria-label") === key) score = 0.98;
    else if (key && (element as HTMLInputElement).placeholder === key)
      score = 0.92;
    // Normalized matches
    else if (normalizedName === normalizedKey) score = 0.95;
    else if (normalizedId === normalizedKey) score = 0.93;
    else if (normalizedAriaLabel === normalizedKey) score = 0.9;
    else if (labelText === normalizedKey) score = 0.85;
    else if (normalizedPlaceholder === normalizedKey) score = 0.8;
    // Partial matches (lower priority but still valid)
    else if (normalizedName && normalizedName.includes(normalizedKey))
      score = 0.75;
    else if (normalizedId && normalizedId.includes(normalizedKey)) score = 0.7;
    else if (labelText && labelText.includes(normalizedKey)) score = 0.65;
    else if (
      normalizedPlaceholder &&
      normalizedPlaceholder.includes(normalizedKey)
    )
      score = 0.6;
    else if (
      normalizedKey &&
      labelText &&
      labelText.includes(
        normalizedKey.substring(0, Math.max(3, normalizedKey.length - 2)),
      )
    )
      score = 0.55; // Partial match on label
    // Reverse check: key contains field identifier
    else if (normalizedName && normalizedKey.includes(normalizedName))
      score = 0.7;
    else if (normalizedId && normalizedKey.includes(normalizedId)) score = 0.65;
    else if (labelText && normalizedKey.includes(labelText)) score = 0.6;

    if (score > (bestMatch?.score || 0)) {
      bestMatch = { element, score };
    }
  }

  // Lower threshold to 0.5 to allow more matches
  return bestMatch && bestMatch.score >= 0.5 ? bestMatch : null;
}

// Internal function that works directly with form element
async function fillFormFieldsDirect(
  form: HTMLFormElement,
  dataMap: Record<string, any>,
  options: FillOptions = {},
): Promise<FillReport> {
  const report: FillReport = {
    filled: [],
    skipped: [],
    notFound: [],
    errors: [],
  };

  if (!form) {
    console.warn(`[Form Filler] Form element is null`);
    report.notFound = Object.keys(dataMap);
    return report;
  }

  const fillableElements = Array.from(
    form.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(
      'input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select',
    ),
  );

  // Debug: log available elements
  if (options.debug) {
    console.log(
      `[Form Filler] Found ${fillableElements.length} fillable elements:`,
      fillableElements.map((el) => ({
        tag: el.tagName,
        name: (el as HTMLInputElement).name,
        id: el.id,
        placeholder: (el as HTMLInputElement).placeholder,
        type: (el as HTMLInputElement).type,
      })),
    );
    console.log(`[Form Filler] Data map keys:`, Object.keys(dataMap));
  }

  const filledElements = new Set<Element>();
  const delay = options.delay ?? 40;

  for (const [key, value] of Object.entries(dataMap)) {
    const availableElements = fillableElements.filter(
      (el) => !filledElements.has(el),
    ) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
    const match = findBestFieldMatch(availableElements, key);
    if (!match) {
      if (options.debug) {
        const availableInfo = availableElements.map((el) => ({
          name: (el as HTMLInputElement).name,
          id: el.id,
          placeholder: (el as HTMLInputElement).placeholder,
          ariaLabel: el.getAttribute("aria-label"),
        }));
        console.warn(
          `[Form Filler] No match found for key: "${key}". Available elements:`,
          availableInfo,
        );

        // Provide suggestion for notFound fields
        if (availableElements.length > 0) {
          const suggestions: string[] = [];
          const normalizedKey = normalize(key);

          availableElements.forEach((el, idx) => {
            const elName = normalize((el as HTMLInputElement).name);
            const elId = normalize(el.id);
            const elPlaceholder = normalize(
              (el as HTMLInputElement).placeholder || "",
            );
            const elAriaLabel = normalize(el.getAttribute("aria-label") || "");

            if (elName && normalizedKey.includes(elName)) {
              suggestions.push(
                `Try using field name "${(el as HTMLInputElement).name}" instead of "${key}"`,
              );
            }
            if (elId && normalizedKey.includes(elId)) {
              suggestions.push(
                `Try using field id "${el.id}" instead of "${key}"`,
              );
            }
            if (elPlaceholder && normalizedKey.includes(elPlaceholder)) {
              suggestions.push(
                `Try using placeholder "${(el as HTMLInputElement).placeholder}" instead of "${key}"`,
              );
            }
            if (elAriaLabel && normalizedKey.includes(elAriaLabel)) {
              suggestions.push(
                `Try using aria-label "${el.getAttribute("aria-label")}" instead of "${key}"`,
              );
            }
          });

          if (suggestions.length === 0) {
            suggestions.push(
              `Field "${key}" not found. Available field identifiers: ${availableInfo.map((info, i) => `[${i}] name="${info.name}", id="${info.id}", placeholder="${info.placeholder}"`).join("; ")}`,
            );
          }

          console.warn(
            `💡 Suggestions for "${key}":`,
            suggestions[0] ||
              "Check if field name/id/placeholder matches the data key",
          );
        }
      }
      report.notFound.push(key);
      continue;
    }

    if (options.debug) {
      console.log(
        `[Form Filler] Matched "${key}" to element with score ${match.score.toFixed(2)}:`,
        {
          name: (match.element as HTMLInputElement).name,
          id: match.element.id,
          placeholder: (match.element as HTMLInputElement).placeholder,
        },
      );
    }
    const { element } = match;
    const inputEl = element as HTMLInputElement;
    if (inputEl.type?.toLowerCase() === "radio" && inputEl.name) {
      const groupName = inputEl.name;
      const radiosInGroup = Array.from(
        form.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${groupName}"]`,
        ),
      );
      let radioToSelect = radiosInGroup.find((r) => r.value === String(value));
      if (radioToSelect) {
        const result = safeSetValue(radioToSelect, String(value), options);
        if (result.status === "filled") {
          report.filled.push(key);
          radiosInGroup.forEach((r) => filledElements.add(r));
        } else if (result.status === "skipped") {
          report.skipped.push(key);
        } else if (result.status === "error") {
          report.errors.push({
            field: key,
            message: `Could not set radio value "${value}" for "${groupName}".`,
            suggestion: result.suggestion,
          });
        }
      } else {
        const availableValues = radiosInGroup.map((r) => r.value).join(", ");
        report.notFound.push(key);
        report.errors.push({
          field: key,
          message: `Radio value "${value}" not found in group "${groupName}".`,
          suggestion: `Available radio values: ${availableValues}. Use one of these exact values.`,
        });
      }
    } else {
      const result = safeSetValue(element, value, options);
      switch (result.status) {
        case "filled":
          report.filled.push(key);
          filledElements.add(element);
          break;
        case "skipped":
          report.skipped.push(key);
          if (result.suggestion && options.debug) {
            console.log(`[Form Filler] Skipped "${key}": ${result.suggestion}`);
          }
          break;
        case "error":
          report.errors.push({
            field: key,
            message: `Could not set value "${value}" for field "${key}".`,
            suggestion:
              result.suggestion ||
              "Check field constraints (maxLength, pattern, validation) or if field is controlled by a framework.",
          });
          break;
      }
    }
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  return report;
}

// Public function that accepts selector string (for backward compatibility)
export async function fillFormFields(
  formSelector: string,
  dataMap: Record<string, any>,
  options: FillOptions = {},
): Promise<FillReport> {
  // Handle both selector strings and direct form element references
  let form: HTMLFormElement | null = null;

  // Try selector first
  form = document.querySelector<HTMLFormElement>(formSelector);

  // If selector matches multiple forms, log warning
  if (form) {
    const allMatches = document.querySelectorAll(formSelector);
    if (allMatches.length > 1) {
      console.warn(
        `[Form Filler] Selector "${formSelector}" matched ${allMatches.length} forms. Using first match. Consider using form index method.`,
      );
    }
  }

  if (!form) {
    const report: FillReport = {
      filled: [],
      skipped: [],
      notFound: [],
      errors: [],
    };
    console.warn(`[Form Filler] Form not found with selector: ${formSelector}`);
    report.notFound = Object.keys(dataMap);
    return report;
  }

  return fillFormFieldsDirect(form, dataMap, options);
}

async function __fillActiveForm(
  dataMap: Record<string, any>,
  options?: FillOptions,
): Promise<void> {
  let activeForm: HTMLFormElement | null = null;
  let formIdentifier: string = "";

  try {
    const result = await chrome.storage.local.get(
      "flowRecorder_lastUserAction",
    );
    const lastUserAction = result.flowRecorder_lastUserAction as
      | UserAction
      | undefined;

    if (!lastUserAction?.elementMetadata) {
      console.error(
        "[Form Filler] Aborted: No last user action metadata found.",
      );
      return;
    }

    const formIndex = lastUserAction.elementMetadata.parentFormIndex;
    const formSelector = lastUserAction.elementMetadata.parentForm;

    // Method 1: Find form by index (most reliable)
    if (typeof formIndex === "number" && formIndex >= 0) {
      const allForms = Array.from(document.querySelectorAll("form"));
      if (formIndex < allForms.length) {
        activeForm = allForms[formIndex] as HTMLFormElement;
        formIdentifier = `index ${formIndex}`;
        if (options?.debug) {
          console.log(
            `[Form Filler] Found form by index ${formIndex} (${allForms.length} total forms on page)`,
          );
        }
      } else {
        console.warn(
          `[Form Filler] Form index ${formIndex} out of range (only ${allForms.length} forms found). Falling back to selector.`,
        );
      }
    }

    // Method 2: Fallback to selector if index method failed
    if (!activeForm && formSelector) {
      try {
        const foundForm = document.querySelector<HTMLFormElement>(formSelector);
        if (foundForm) {
          activeForm = foundForm;
          formIdentifier = `selector "${formSelector}"`;
          if (options?.debug) {
            console.log(
              `[Form Filler] Found form by selector: ${formSelector}`,
            );
          }
        } else {
          console.warn(
            `[Form Filler] Form selector "${formSelector}" did not match any form.`,
          );
        }
      } catch (selectorError) {
        console.warn(
          `[Form Filler] Invalid form selector "${formSelector}":`,
          selectorError,
        );
      }
    }

    // Method 3: Last resort - find form containing the last interacted element
    const selectorString =
      typeof lastUserAction.selector === "string"
        ? lastUserAction.selector
        : lastUserAction.selector &&
            typeof lastUserAction.selector === "object" &&
            "css" in lastUserAction.selector
          ? lastUserAction.selector.css
          : null;

    if (!activeForm && selectorString) {
      try {
        const lastElement = document.querySelector(selectorString);
        if (lastElement) {
          const parentForm = lastElement.closest("form");
          if (parentForm) {
            activeForm = parentForm as HTMLFormElement;
            formIdentifier = "closest form to last element";
            if (options?.debug) {
              console.log(
                `[Form Filler] Found form by finding closest form to last interacted element`,
              );
            }
          }
        }
      } catch (e) {
        console.warn(
          `[Form Filler] Could not find form via last element selector:`,
          e,
        );
      }
    }
  } catch (e) {
    console.error("[Form Filler] Error accessing chrome.storage.local.", e);
    return;
  }

  if (!activeForm) {
    console.error(
      "[Form Filler] Aborted: Could not locate active form using any method.",
    );
    return;
  }

  console.log(
    `[Form Filler] Active form detected via ${formIdentifier}. Starting fill...`,
  );
  // Pass the form element directly instead of using selector
  const report = await fillFormFieldsDirect(activeForm, dataMap, options);
  console.log("%c[Form Filler] Operation Complete.", "font-weight: bold;");
  console.table({
    filled: { fields: report.filled.join(", ") || "None" },
    skipped: { fields: report.skipped.join(", ") || "None" },
    notFound: { fields: report.notFound.join(", ") || "None" },
    errors: { count: report.errors.length },
  });
  if (report.errors.length > 0) {
    console.error(
      "%c[Form Filler] Errors occurred:",
      "color: red; font-weight: bold;",
    );
    report.errors.forEach((error, index) => {
      console.error(`%cError ${index + 1}: ${error.field}`, "color: red;");
      console.error(`  Message: ${error.message}`);
      if (error.suggestion) {
        console.warn(`  💡 Suggestion: ${error.suggestion}`);
      }
    });
  }
}

if (typeof window !== "undefined") {
  (window as any).__fillActiveForm = __fillActiveForm;

  // Direct form-element filler — bypasses storage lookup.
  // Used when we want to fill a specific form captured *before* an async AI call,
  // so a later change in focus / lastUserAction can't derail it.
  (window as any).__fillFormElement = async function (
    form: HTMLFormElement,
    dataMap: Record<string, any>,
    options?: FillOptions,
  ): Promise<void> {
    if (!(form instanceof HTMLFormElement)) {
      console.error(
        "[Form Filler] __fillFormElement: received invalid form element.",
      );
      return;
    }
    console.log("[Form Filler] Filling pinned form element directly...");
    const report = await fillFormFieldsDirect(form, dataMap, options ?? {});
    console.log("%c[Form Filler] Operation Complete.", "font-weight: bold;");
    console.table({
      filled: { fields: report.filled.join(", ") || "None" },
      skipped: { fields: report.skipped.join(", ") || "None" },
      notFound: { fields: report.notFound.join(", ") || "None" },
      errors: { count: report.errors.length },
    });
    if (report.errors.length > 0) {
      report.errors.forEach((err, i) => {
        console.error(
          `[Form Filler] Error ${i + 1} on field "${err.field}": ${err.message}`,
        );
      });
    }
  };

  /**
   * Scans a form for visible validation errors after a fill/submit attempt.
   * Checks: aria-invalid attributes, HTML5 validity API, common error-message
   * class names, and role="alert" elements inside the form.
   * Returns an array of { fieldId, fieldName, errorText } objects.
   */
  (window as any).__detectFormErrors = function (
    form: HTMLFormElement,
  ): { fieldId: string; fieldName: string; errorText: string }[] {
    if (!(form instanceof HTMLFormElement)) return [];

    const errors: { fieldId: string; fieldName: string; errorText: string }[] =
      [];
    const seen = new Set<string>(); // deduplicate by fieldId+fieldName key

    const addError = (id: string, name: string, text: string) => {
      const key = `${id}::${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({
          fieldId: id,
          fieldName: name,
          errorText: text || "Invalid value",
        });
      }
    };

    const getErrorMessage = (el: Element): string => {
      // 1. aria-describedby
      const describedBy = el.getAttribute("aria-describedby");
      if (describedBy) {
        const desc = describedBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .find((d) => d?.textContent?.trim());
        if (desc) return desc.textContent!.trim();
      }
      // 2. Sibling / child error elements in the same container
      const container =
        el.closest(
          ".form-field, .form-group, .input-group, [class*='field'], [class*='Field'], [class*='control'], [class*='Control']",
        ) || el.parentElement;
      if (container) {
        const msgEl = container.querySelector(
          '.error, .error-message, .invalid-feedback, .field-error, .form-error, [class*="error"], [class*="Error"], [role="alert"]',
        );
        if (msgEl && msgEl !== el) {
          const text = msgEl.textContent?.trim();
          if (text) return text;
        }
      }
      return "";
    };

    // --- Pass 1: aria-invalid fields ---
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      const inp = el as HTMLInputElement;
      addError(inp.id || "", inp.name || "", getErrorMessage(el));
    });

    // --- Pass 2: HTML5 native validity ---
    form
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("input, textarea, select")
      .forEach((inp) => {
        if (
          (inp.validity &&
            !inp.validity.valid &&
            !inp.validity.valueMissing === false) ||
          (inp.validity && !inp.validity.valid)
        ) {
          addError(inp.id || "", inp.name || "", inp.validationMessage || "");
        }
      });

    // --- Pass 3: Error message elements with visible text ---
    const ERROR_SELECTORS =
      ".error-message, .invalid-feedback, .field-error, .form-error, " +
      '[class*="error-text"], [class*="errorText"], [class*="ErrorText"], ' +
      '[class*="validationMessage"], [class*="validation-message"], [role="alert"]';
    form.querySelectorAll(ERROR_SELECTORS).forEach((msgEl) => {
      const text = msgEl.textContent?.trim();
      if (!text) return;
      const container =
        msgEl.closest(
          ".form-field, .form-group, .input-group, [class*='field'], [class*='Field'], [class*='control'], [class*='Control']",
        ) || msgEl.parentElement;
      const inp = container?.querySelector<HTMLInputElement>(
        "input, textarea, select",
      );
      if (inp) addError(inp.id || "", inp.name || "", text);
    });

    if (errors.length > 0) {
      console.warn(
        `[Form Filler] Detected ${errors.length} validation error(s):`,
        errors,
      );
    }
    return errors;
  };
}
