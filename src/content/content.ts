import { generateCSSSelector, generateXPath } from "@/utils/selectorGenerator";
import {
  extractElementMetadata,
  isFormElement,
  getParentForm,
} from "@/utils/elementAnalyzer";
import {
  detectRouteChanges,
  getCurrentRoute,
  getCurrentURL,
  sanitizeURL,
} from "@/utils/navigationDetector";
import { overrideFetch, overrideXHR } from "@/utils/apiInterceptor";
import {
  saveEvent,
  getOrCreateSessionId,
  isRecording,
  createNewSessionId,
  setRecordingStatus,
} from "@/utils/storage";
import { ACTION_TYPES } from "@/types/index";
import { createFlyout } from "./flyout";
import "./flyout.css";
import { generatePredictions, PageContext, ActionCandidate, Form } from "@/utils/predictionEngine";


// PART 1: Store last recorded event
let lastRecordedEvent: (any & { boundingBox?: DOMRect }) | null = null;


// PART 2: Implement robust page intent inference
function inferPageIntent(): string {
    const scores = {
        authentication: 0.0,
        search: 0.0,
        checkout: 0.0,
    };

    // --- Authentication Signals (Language Agnostic) ---
    const passwordFields = Array.from(document.querySelectorAll('input[type="password"]'));
    const visiblePasswordFields = passwordFields.filter(el => (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0);
    if (visiblePasswordFields.length > 0) {
        scores.authentication += 0.6; // Strong signal
    }

    document.querySelectorAll('form').forEach(form => {
        const hasPasswordField = form.querySelector('input[type="password"]') !== null;
        if (!hasPasswordField) return;

        const hasTextField = form.querySelector('input[type="text"], input[type="email"], input[type="tel"]') !== null;
        const hasSubmit = form.querySelector('button, input[type="submit"], [role="button"]') !== null;

        if (hasTextField && hasSubmit) {
            scores.authentication += 0.3; // Very strong signal for a complete login form
        }
    });

    // --- Search Signals ---
    if (document.querySelector('form[action*="/search"], form[id*="search"], form[class*="search"]')) {
        scores.search += 0.4;
    }
    if (document.querySelector('input[type="search"], input[name="q"], input[name="s"], input[id*="search"]')) {
        scores.search += 0.4;
    }

    // --- Checkout Signals (with some i18n) ---
    const checkoutKeywords = ['cart', 'checkout', 'payment', 'basket', 'rechnung', 'kasse', 'panier'];
    try {
        const pageText = document.body.innerText.toLowerCase();
        for (const keyword of checkoutKeywords) {
            if (pageText.includes(keyword)) {
                scores.checkout += 0.1;
            }
        }
    } catch(e) { /* document.body may not be ready */ }
    
    if (document.querySelector('[class*="checkout"], [id*="checkout"], [class*="cart"]')) {
        scores.checkout += 0.4;
    }
    
    // --- Ranking and Confidence Check ---
    const rankedIntents = Object.entries(scores)
        .filter(([, score]) => score > 0)
        .sort(([, a], [, b]) => b - a);

    if (rankedIntents.length === 0) {
        return 'unknown';
    }

    const [topIntent, topScore] = rankedIntents[0];
    const secondScore = rankedIntents.length > 1 ? rankedIntents[1][1] : 0;
    
    // The top score must be significantly higher than the next, or be very high itself.
    if (topScore - secondScore < 0.2 && topScore < 0.5) {
        return 'unknown';
    }

    return topIntent;
}

// Updated context builder for debugging
function buildPageContextForDebugging(): PageContext {
    const visibleActions: ActionCandidate[] = [];
    document.querySelectorAll('a, button, [role="button"], input[type="submit"]').forEach(el => {
        const element = el as HTMLElement;

        // OBJECTIVE 1 FIX: Exclude extension's own UI from the context.
        if (element.closest('[data-flow-recorder]')) {
            return;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (element.innerText || element.getAttribute('aria-label') || '').trim() !== '') {
            // TASK 2 FIX: Find the parent form for each candidate and add its selector.
            const parentForm = element.closest('form');

            visibleActions.push({
                label: (element.innerText || element.getAttribute('aria-label') || '').trim(),
                selector: generateCSSSelector(element),
                role: (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' || element.getAttribute('type') === 'submit') ? 'primary' : 'link',
                boundingBox: rect,
                confidenceScore: 0.7,
                formSelector: parentForm
                  ? generateCSSSelector(parentForm)
                  : undefined,
            });
        }
    });

    const forms: Form[] = [];
    document.querySelectorAll('form').forEach(form => {
        forms.push({
            selector: generateCSSSelector(form),
            completionScore: 0,
            fields: [],
        });
    });

    return {
        pageIntent: inferPageIntent(),
        visibleActions: visibleActions.slice(0, 50),
        forms,
        lastUserAction: lastRecordedEvent ? {
            type: lastRecordedEvent.actionType,
            selector: lastRecordedEvent.selector.css,
            formSelector: lastRecordedEvent.elementMetadata?.parentForm,
        } : null,
        lastActionRect: lastRecordedEvent ? lastRecordedEvent.boundingBox : null,
        viewport: {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
        }
    };
}


let sessionId: string | null = null;
let isRecordingActive = false;
const OVERLAY_ID = "__flow_recorder_overlay__";
const FLYOUT_ID = "flow-recorder-flyout";
let cleanupRouteDetector: (() => void) | null = null;
let cleanupFetchInterceptor: (() => void) | null = null;
let cleanupXHRInterceptor: (() => void) | null = null;

// if (process.env.NODE_ENV === "development") {
  console.log('[FlowRecorder] Running in development mode')
  
  // Refactored: Use a getter for live updates, preventing stale references.
  Object.defineProperty(window, "__lastRecordedEvent", {
    get() {
      return lastRecordedEvent;
    },
    configurable: true, // Allows re-definition if the script is re-injected
  });

  // @ts-ignore
  window.__debugContextBuilder = () => {
    const context = buildPageContextForDebugging();
    console.log('[FlowRecorder] Page Context:', context);
    const predictions = generatePredictions(context);
    console.log('[FlowRecorder] Predictions:', predictions);
    return predictions;
  }
// }

async function init() {
  isRecordingActive = await isRecording();
  sessionId = await getOrCreateSessionId();

  chrome.runtime.onMessage.addListener(handleMessage as any);

  // Always-on interaction capture for prediction engine
  document.addEventListener("click", captureInteraction, true);
  document.addEventListener("input", captureInteraction, true);
  document.addEventListener("focusin", captureInteraction, true);

  // If recording was already active from a previous session, attach other listeners
  if (isRecordingActive) {
    attachRecordingListeners();
  }
}

function handleMessage(request: any, sender: any, sendResponse: any) {
  (async () => {
    switch (request.action) {
      case "START_RECORDING":
        await startRecording();
        sendResponse({ success: true });
        break;

      case "STOP_RECORDING":
        await stopRecording();
        sendResponse({ success: true });
        break;

      case "GET_SESSION_ID":
        sendResponse({ sessionId });
        break;

      case "IS_RECORDING":
        sendResponse({ isRecording: isRecordingActive });
        break;

      case "REDO_ACTION":
        const response = await handleRedoAction(request.event);
        sendResponse(response);
        break;

      default:
        sendResponse({ error: "Unknown action" });
    }
  })();

  return true; // Indicates that the response is sent asynchronously
}

async function handleRedoAction(
  event: any,
): Promise<{ success: boolean; error?: string }> {
  if (!event || !event.selector || !event.selector.css) {
    return { success: false, error: "Invalid event data or selector" };
  }

  const element = document.querySelector(event.selector.css) as HTMLElement;
  if (!element) {
    return {
      success: false,
      error: `Element not found with selector: ${event.selector.css}`,
    };
  }

  // Scroll element into view
  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // Brief highlight to show which element is being acted upon
  const originalStyle = element.style.outline;
  element.style.outline = "2px solid red";
  await new Promise((r) => setTimeout(r, 500));
  element.style.outline = originalStyle;

  switch (event.actionType) {
    case ACTION_TYPES.CLICK:
      (element as HTMLElement).click();
      break;

    case ACTION_TYPES.INPUT:
      const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
      inputElement.value = event.elementMetadata?.value || "";
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      inputElement.dispatchEvent(new Event("change", { bubbles: true }));
      break;

    default:
      return {
        success: false,
        error: `Action type "${event.actionType}" is not supported for redo.`,
      };
  }

  return { success: true };
}

async function startRecording() {
  if (isRecordingActive) return;
  
  isRecordingActive = true;
  sessionId = await createNewSessionId();
  await setRecordingStatus(true);
  
  attachRecordingListeners();
  
  console.log("[FlowRecorder] Recording started");
}

function attachRecordingListeners() {
  // Interaction listeners are now always on. This function only handles
  // recording-specific setup.
  if (!isRecordingActive) return;

  showRecordingOverlay();
  analyzePageAndShowFlyout();

  // Attach listeners that should ONLY run during recording
  cleanupRouteDetector = detectRouteChanges(handleRouteChange as any);
  cleanupFetchInterceptor = overrideFetch(handleAPICall as any);
  cleanupXHRInterceptor = overrideXHR(handleAPICall as any);
}

async function stopRecording() {
  if (!isRecordingActive) return;

  isRecordingActive = false;
  await setRecordingStatus(false);

  detachRecordingListeners();

  console.log("[FlowRecorder] Recording stopped");
}

function detachRecordingListeners() {
  // Interaction listeners are always on. This function only handles
  // recording-specific cleanup.
  removeRecordingOverlay();
  const flyout = document.getElementById(FLYOUT_ID);
  if (flyout) {
    flyout.remove();
  }

  // document.removeEventListener("click", handleInteraction, true);
  // document.removeEventListener("input", handleInteraction, true);
  // document.removeEventListener("focusin", handleInteraction, true);

  if (cleanupRouteDetector) {
    cleanupRouteDetector();
    cleanupRouteDetector = null;
  }

  if (cleanupFetchInterceptor) {
    cleanupFetchInterceptor();
    cleanupFetchInterceptor = null;
  }

  if (cleanupXHRInterceptor) {
    cleanupXHRInterceptor();
    cleanupXHRInterceptor = null;
  }
}

function analyzePageAndShowFlyout() {
  if (document.getElementById(FLYOUT_ID)) return;

  const flyout = createFlyout();
  const content = flyout.querySelector("#flyout-content");
  if (!content) return;

  content.innerHTML = ""; // Clear "Analyzing..." message

  const actions = [];

  // Find buttons
  document.querySelectorAll("button, a[role='button']").forEach((el) => {
    const element = el as HTMLElement;
    const text = element.innerText.trim();
    if (text) {
      actions.push({
        label: `Click "${text}"`,
        element,
        actionType: ACTION_TYPES.CLICK,
      });
    }
  });

  // Find forms and suggest submitting
  document.querySelectorAll("form").forEach((form) => {
    actions.push({
      label: `Submit form#${form.id || "(no id)"}`,
      element: form,
      actionType: ACTION_TYPES.SUBMIT,
    });
  });

  if (actions.length === 0) {
    content.innerHTML = "<p>No suggested actions found.</p>";
    return;
  }

  actions.forEach((action) => {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.onclick = () => {
      const event = {
        actionType: action.actionType,
        selector: {
          css: generateCSSSelector(action.element),
        },
      };
      handleRedoAction(event);
    };
    content.appendChild(button);
  });
}

const INTERACTIVE_ELEMENTS = "input, button, a, textarea, select";

const captureInteraction = async (event: Event) => {
    const target = event.target as HTMLElement;

    // Ignore events on the overlay, which should only exist during recording
    if (!target || target.closest(`#${OVERLAY_ID}`)) {
        return;
    }

    // 1. Resolve correct interactive element
    let interactiveElement: HTMLElement | null = target.closest(INTERACTIVE_ELEMENTS);
    
    if (!interactiveElement) {
        // For focusin, the event target can sometimes be the element itself.
        if (event.type === 'focusin' && target.matches(INTERACTIVE_ELEMENTS)) {
            interactiveElement = target;
        } else {
            return; // Not an element we want to track
        }
    }

    // 2. Ignore invisible elements and call getBoundingClientRect() once
    const rect = interactiveElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        return; // Element is not visible
    }
    
    // 3. Store bounding box as plain serializable object
    const boundingBox = {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
    };

    const actionType = event.type === 'focusin' ? 'focus' : event.type;
    
    // TASK 1 FIX: Use closest() to find the parent form and store its selector.
    const parentForm = interactiveElement.closest('form');

    // 4. Create event data object
    const eventData = {
        sessionId,
        timestamp: Date.now(),
        url: sanitizeURL(window.location.href),
        route: getCurrentRoute(),
        actionType: actionType,
        elementMetadata: {
            ...extractElementMetadata(interactiveElement),
            value: (interactiveElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
            // Ensure the property name is 'parentForm' for the context builder.
            parentForm: parentForm
              ? generateCSSSelector(parentForm)
              : undefined,
        },
        selector: {
            css: generateCSSSelector(interactiveElement),
            xpath: generateXPath(interactiveElement),
        },
        boundingBox,
    };

    // 5. Always assign to module-level lastRecordedEvent for the prediction engine
    lastRecordedEvent = eventData;

    // 6. Conditionally persist event only if recording is active
    if (isRecordingActive) {
        console.log(`[FlowRecorder] Interaction Recorded:`, {
            action: actionType,
            element: interactiveElement
        });
        await saveEvent(eventData as any);
        chrome.runtime.sendMessage({ action: "EVENT_RECORDED", event: eventData }).catch(() => {});
    }
};

const handleRouteChange = async (routeInfo: any) => {
  if (!isRecordingActive) return;

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: routeInfo.newRoute,
    actionType: ACTION_TYPES.ROUTE_CHANGE,
    elementMetadata: {
      previousRoute: routeInfo.previousRoute,
    },
  };

  await saveEvent(eventData as any);

  chrome.runtime
    .sendMessage({ action: "EVENT_RECORDED", event: eventData })
    .catch(() => {});
};

const handleAPICall = async (apiDetails: any) => {
  if (!isRecordingActive) return;

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: getCurrentRoute(),
    actionType: ACTION_TYPES.API_CALL,
    apiDetails: {
      method: apiDetails.method,
      endpoint: apiDetails.endpoint,
      status: apiDetails.status,
      duration: apiDetails.duration,
    },
  };

  await saveEvent(eventData as any);

  chrome.runtime
    .sendMessage({ action: "EVENT_RECORDED", event: eventData })
    .catch(() => {});
};

function shouldTrackElement(element: HTMLElement | null): boolean {
  if (!element) return false;

  if (element.closest(`#${OVERLAY_ID}`)) return false;

  const tagName = element.tagName.toLowerCase();
  const ignoreTags = ["html", "body", "script", "style", "meta", "head"];
  if (ignoreTags.includes(tagName)) {
    return false;
  }

  const interactiveTags = [
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "details",
    "summary",
  ];
  if (interactiveTags.includes(tagName)) {
    return true;
  }

  const role = element.getAttribute("role");
  const interactiveRoles = [
    "button",
    "link",
    "menuitem",
    "tab",
    "checkbox",
    "radio",
    "switch",
  ];
  if (role && interactiveRoles.includes(role)) {
    return true;
  }

  if (
    element.hasAttribute("onclick") ||
    element.hasAttribute("ng-click") ||
    element.hasAttribute("v-on:click")
  ) {
    return true;
  }

  if (window.getComputedStyle(element).cursor === "pointer") {
    return true;
  }

  return false;
}

function showRecordingOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Add a stable attribute to identify this as part of the extension's UI
  overlay.dataset.flowRecorder = "true";
  
  overlay.style.position = "fixed";
  overlay.style.top = "0";
  overlay.style.left = "0";
  overlay.style.width = "100vw";
  overlay.style.height = "100vh";
  overlay.style.background = "rgba(255, 0, 0, 0.08)";
  overlay.style.zIndex = "2147483647";
  overlay.style.pointerEvents = "none";
  overlay.style.display = "flex";
  overlay.style.alignItems = "flex-start";
  overlay.style.justifyContent = "flex-end";
  overlay.style.fontFamily = "sans-serif";
  overlay.innerHTML = `<div style="margin:16px 24px;padding:8px 18px;background:#d32f2f;color:#fff;border-radius:8px;font-size:1.1em;box-shadow:0 2px 8px #0002;pointer-events:auto;">🔴 Recording...</div>`;
  if (document.body) {
    document.body.appendChild(overlay);
  }
}

function removeRecordingOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
}

init();
