import { RecordedEvent } from "../types";

// Using RecordedEvent as the equivalent of UserAction
export type UserAction = RecordedEvent;

// --- CONSTANTS ---
const MAX_SELECTOR_DEPTH = 4;
const MAX_ACTION_CANDIDATES = 50;
const INTENT_CONFIDENCE_THRESHOLD = 0.2;

// 1. Data Model Definitions
// These types define the structured information we want to extract from the page.

/**
 * High-level intent of the page, inferred through heuristics.
 */
export type PageIntent =
  | "authentication"
  | "search"
  | "checkout"
  | "form_submission"
  | "navigation"
  | "dashboard"
  | "unknown";

/**
 * Represents a single input field within a form.
 * Privacy: Never stores the actual value, only its presence.
 */
export interface FieldContext {
  label: string;
  type: string;
  selector: string;
  required: boolean;
  filled: boolean;
}

/**
 * Represents a form detected on the page.
 */
export interface FormContext {
  formSelector: string;
  fields: FieldContext[];
  completionScore: number; // Ratio of filled fields to total fields
}

/**
 * Represents a visible, interactable element that a user can act upon.
 */
export interface ActionCandidate {
  label: string;
  selector: string;
  role: "primary" | "secondary" | "link" | "unknown";
  boundingBox: DOMRect;
  confidenceScore: number; // How likely this is a meaningful action
}

/**
 * The main structured model of the current page's context.
 */
export interface PageContext {
  url: string;
  title: string;
  pageIntent: PageIntent | null;
  visibleActions: ActionCandidate[];
  forms: FormContext[];
  lastUserAction: UserAction | null;
  timestamp: number;
  lastActionRect: DOMRect | null;
}

// 2. Helper Utilities
// These are small, pure functions that perform common checks and transformations.

interface ElementVisualDetails {
  rect: DOMRect;
  isInViewport: boolean;
  isVisible: boolean;
}

/**
 * [PERFORMANCE] Optimizes visibility checks. It first uses cheap properties
 * and only calls getBoundingClientRect once if necessary.
 * @param element The element to check
 * @returns An object with rect, isInViewport, and isVisible, or null if not visible.
 */
function getElementVisualDetails(
  element: Element,
): ElementVisualDetails | null {
  if (
    !element ||
    (element as HTMLElement).offsetParent === null ||
    element.hasAttribute("disabled")
  ) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  // Tiny elements are not considered visible actions
  if (rect.width < 5 || rect.height < 5) {
    return null;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    parseFloat(style.opacity) < 0.1
  ) {
    return null;
  }

  const isInViewport =
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0;

  return { rect, isInViewport, isVisible: true };
}

/**
 * [STABILITY] Generates a stable, escaped CSS selector with limited depth.
 * This version is hardened against characters that are invalid in CSS selectors (e.g., '/').
 * It prioritizes unique, stable attributes and filters out dynamic/unstable class names.
 * @param el The element to generate a selector for.
 * @returns A valid CSS selector string.
 */
function generateStableSelector(el: Element): string {
  if (!el) return "";

  // 1. Prioritize unique and stable attributes, now with escaping
  if (el.id) {
    const selector = `#${CSS.escape(el.id.trim())}`;
    try {
      // Verify that the selector is valid and unique
      if (document.querySelector(selector) === el) return selector;
    } catch (e) {
      /* ignore invalid selector */
    }
  }

  const dataTestId = el.getAttribute("data-testid");
  if (dataTestId) {
    const selector = `[data-testid="${CSS.escape(dataTestId)}"]`;
    try {
      if (document.querySelector(selector) === el) return selector;
    } catch (e) {
      /* ignore invalid selector */
    }
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    const selector = `[aria-label="${CSS.escape(ariaLabel)}"]`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch (e) {
      /* ignore invalid selector */
    }
  }

  const name = el.getAttribute("name");
  if (name) {
    const selector = `[name="${CSS.escape(name)}"]`;
    try {
      if (document.querySelector(selector) === el) return selector;
    } catch (e) {
      /* ignore invalid selector */
    }
  }

  // 2. Fallback to path-based selector
  let path = "";
  let current: Element | null = el;
  let depth = 0;
  while (
    current &&
    current.nodeType === Node.ELEMENT_NODE &&
    current.tagName.toLowerCase() !== "body" &&
    depth < MAX_SELECTOR_DEPTH
  ) {
    let selector = current.tagName.toLowerCase();

    // Filter for stable classes, limit to 2, and escape them
    const stableClasses = Array.from(current.classList)
      .filter(
        (cls) =>
          !/^[a-z0-9_-]{8,}$/i.test(cls) && // Exclude long, random-like strings (potential hashes)
          !cls.includes(":") && // Exclude state variants like 'hover:'
          !cls.includes("/"), // Exclude fractional utilities like 'w-1/2'
      )
      .slice(0, 2);

    if (stableClasses.length > 0) {
      selector += "." + stableClasses.map((cls) => CSS.escape(cls)).join(".");
    }

    const parent = current.parentElement;
    if (parent) {
      try {
        const siblings = Array.from(
          parent.querySelectorAll(`:scope > ${selector}`),
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current);
          if (index !== -1) {
            selector += `:nth-of-type(${index + 1})`;
          }
        }
      } catch (e) {
        // If the selector is invalid (e.g., due to an unhandled class char),
        // fall back to just the tag name for this level to prevent a crash.
        selector = current.tagName.toLowerCase();
      }
    }

    path = selector + (path ? ` > ${path}` : "");

    // Early exit if we find a selector that's unique enough
    try {
      if (document.querySelector(path) === el) {
        break;
      }
    } catch (e) {
      // Path may be invalid during construction, continue and hope the next level is better
    }

    current = current.parentElement;
    depth++;
  }

  // Final safety check. If the generated path is invalid or doesn't resolve, return a basic tag selector.
  try {
    if (document.querySelector(path) === el) {
      return path;
    }
  } catch (e) {
    // Fallback for completely invalid selector
  }

  return el.tagName.toLowerCase();
}

/**
 * Gets the accessible name of an element for use as a label.
 * @param element The element to get the name from.
 * @returns A string representing the element's accessible name.
 */
function getAccessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  // Use textContent for a cleaner text representation than innerText
  if ("textContent" in element && element.textContent) {
    return element.textContent.trim().replace(/\s+/g, " ").substring(0, 100);
  }

  const title = element.getAttribute("title");
  if (title) return title.trim();

  return "";
}

/**
 * Heuristically determines the role of an action (e.g., primary vs. secondary button).
 * @param element The action element.
 * @returns The inferred role.
 */
function getActionRole(element: Element): ActionCandidate["role"] {
  if (element.tagName === "A") return "link";

  const className = element.className.toLowerCase();
  if (className.includes("primary") || className.includes("submit"))
    return "primary";
  if (className.includes("secondary") || className.includes("cancel"))
    return "secondary";

  return "unknown";
}

// 3. Core Extraction Functions

/**
 * [PRIVACY] This function is designed to be privacy-safe.
 * - It NEVER reads or stores the `value` of input fields.
 * - It only checks for the *presence* of a value (`.value.length > 0`) to set a boolean `filled` flag.
 * - It does not capture `innerHTML`, `outerHTML`, or other attributes that might contain sensitive PII.
 * - The goal is to understand the structure and state of a form, not its content.
 */
function extractForms(root: Document | ShadowRoot = document): FormContext[] {
  const forms: FormContext[] = [];
  const formElements = root.querySelectorAll("form");

  formElements.forEach((form) => {
    const visualDetails = getElementVisualDetails(form);
    if (!visualDetails?.isInViewport) return;

    const formSelector = generateStableSelector(form);
    const fields: FieldContext[] = [];
    const fieldElements = form.querySelectorAll("input, textarea, select");
    let filledCount = 0;

    fieldElements.forEach((field) => {
      if (
        !(
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        )
      )
        return;

      const type = field.getAttribute("type") || field.tagName.toLowerCase();

      const isFilled =
        type === "checkbox" || type === "radio"
          ? (field as HTMLInputElement).checked
          : field.value.length > 0;

      if (isFilled) filledCount++;

      let label = "";
      if (field.labels && field.labels.length > 0) {
        label = getAccessibleName(field.labels[0]);
      } else {
        const labelEl = field.closest("label");
        if (labelEl) label = getAccessibleName(labelEl);
      }

      fields.push({
        label,
        type,
        selector: generateStableSelector(field),
        required: field.hasAttribute("required"),
        filled: isFilled,
      });
    });

    if (fields.length > 0) {
      forms.push({
        formSelector,
        fields,
        completionScore: fields.length > 0 ? filledCount / fields.length : 0,
      });
    }
  });

  return forms;
}

/**
 * Extracts visible, interactable action candidates, limited to the most relevant ones.
 * @param root The document or shadow root to search within.
 * @returns An array of ActionCandidate objects.
 */
function extractVisibleActions(
  root: Document | ShadowRoot = document,
): ActionCandidate[] {
  let candidates: (ActionCandidate & { sortScore: number })[] = [];
  const actionSelector =
    'button, a, [role="button"], input[type="submit"], [onclick]';
  const elements = root.querySelectorAll(actionSelector);
  const viewportCenterY = window.innerHeight / 2;

  elements.forEach((element) => {
    if (!(element instanceof HTMLElement)) return;

    const visualDetails = getElementVisualDetails(element);
    if (!visualDetails?.isInViewport) return;

    const label = getAccessibleName(element);
    if (!label) return;

    let confidence = 0.5;
    if (element.tagName === "BUTTON") confidence = 0.9;
    else if (element.tagName === "A") confidence = 0.7;
    else if (
      element.tagName === "INPUT" &&
      element.getAttribute("type") === "submit"
    )
      confidence = 0.95;
    else if (element.hasAttribute("onclick") && element.tagName === "DIV")
      confidence = 0.4;

    // Prioritization score for candidate reduction
    const distanceFromCenter = Math.abs(
      visualDetails.rect.top + visualDetails.rect.height / 2 - viewportCenterY,
    );
    const centralityScore = 1 - distanceFromCenter / viewportCenterY; // Normalize to 0-1
    const sortScore = confidence + centralityScore * 0.5; // Weight confidence more

    candidates.push({
      label,
      selector: generateStableSelector(element),
      role: getActionRole(element),
      boundingBox: visualDetails.rect,
      confidenceScore: confidence,
      sortScore,
    });
  });

  // Limit candidate explosion
  if (candidates.length > MAX_ACTION_CANDIDATES) {
    candidates = candidates
      .sort((a, b) => b.sortScore - a.sortScore)
      .slice(0, MAX_ACTION_CANDIDATES);
  }

  return candidates;
}

// 4. Intent Inference Logic

/**
 * [CONFIDENCE] Infers page purpose using a heuristic scoring model.
 * It only returns a confident intent if the top score is significantly
 * higher than the second-best, preventing ambiguity.
 * @returns The most likely PageIntent.
 */
function inferPageIntent(
  url: string,
  forms: FormContext[],
  actions: ActionCandidate[],
): PageIntent {
  const scores: Record<PageIntent, number> = {
    authentication: 0,
    search: 0,
    checkout: 0,
    form_submission: 0,
    navigation: 0,
    dashboard: 0,
    unknown: 0,
  };

  // URL-based scoring
  if (url.includes("login") || url.includes("signin") || url.includes("auth"))
    scores.authentication += 0.5;
  if (url.includes("signup") || url.includes("register"))
    scores.authentication += 0.5;
  if (url.includes("search")) scores.search += 0.5;
  if (
    url.includes("checkout") ||
    url.includes("cart") ||
    url.includes("payment")
  )
    scores.checkout += 0.6;
  if (
    url.includes("dashboard") ||
    url.includes("account") ||
    url.includes("profile")
  )
    scores.dashboard += 0.5;

  // Content-based scoring from forms
  forms.forEach((form) => {
    scores.form_submission += 0.2;
    if (form.fields.some((f) => f.type === "password"))
      scores.authentication += 0.4;
    if (
      form.fields.some(
        (f) => f.selector.includes("card") || f.selector.includes("payment"),
      )
    )
      scores.checkout += 0.3;
  });

  // Content-based scoring from actions
  actions.forEach((action) => {
    const lowerLabel = action.label.toLowerCase();
    if (lowerLabel.includes("search")) scores.search += 0.3;
    if (lowerLabel.includes("login") || lowerLabel.includes("sign in"))
      scores.authentication += 0.3;
    if (lowerLabel.includes("pay") || lowerLabel.includes("checkout"))
      scores.checkout += 0.3;
  });

  const sortedIntents = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sortedIntents[0];
  const [, secondScore] = sortedIntents[1];

  // Only return a confident intent if there's a clear winner
  if (topScore > 0 && topScore - secondScore >= INTENT_CONFIDENCE_THRESHOLD) {
    return topIntent as PageIntent;
  }

  return "unknown";
}

// 5. Exported helper for intent detection
export { inferPageIntent };

// 6. Main Exported Function

/**
 * Builds the complete PageContext for the current state of the page.
 * This is the primary entry point for this module.
 *
 * NOTE on Shadow DOM: This implementation does not recursively traverse Shadow DOM trees
 * for performance reasons. It operates on the provided `root` (defaulting to `document`).
 * To support Shadow DOM, one would need to traverse the DOM, find elements with a `shadowRoot`,
 * and recursively call the extraction functions on that root. This can have significant
 * performance costs on complex component-based pages.
 *
 * @param lastUserAction The last recorded event from the user, can be null.
 * @returns A PageContext object.
 */
export function buildPageContext(
  lastUserAction: UserAction | null,
): PageContext {
  if (process.env.NODE_ENV === "development") {
    console.time("buildPageContext");
  }

  const url = window.location.href;
  const title = document.title;

  const forms = extractForms(document);
  const visibleActions = extractVisibleActions(document);
  const pageIntent = inferPageIntent(url, forms, visibleActions);

  const lastActionRect = lastUserAction?.elementMetadata?.boundingBox
    ? DOMRect.fromRect(lastUserAction.elementMetadata.boundingBox)
    : null;

  if (process.env.NODE_ENV === "development") {
    console.timeEnd("buildPageContext");
  }

  return {
    url,
    title,
    pageIntent,
    visibleActions,
    forms,
    lastUserAction,
    timestamp: Date.now(),
    lastActionRect,
  };
}
