import { generateCSSSelector, generateXPath } from "@/utils/selectorGenerator";
import { extractElementMetadata } from "@/utils/elementAnalyzer";
import {
  getCurrentRoute,
  getCurrentURL,
  sanitizeURL,
} from "@/utils/navigationDetector";
import {
  saveEvent,
  getOrCreateSessionId,
  isRecording,
  setRecordingStatus,
  saveLastUserAction,
  isAgentEnabled,
  setAgentEnabled,
} from "@/utils/storage";
import { ACTION_TYPES } from "@/types/index";
import {
  generatePredictions,
  maybeUseAI,
  PageContext,
  ActionCandidate,
  PredictionResult,
  RankedPrediction,
} from "@/utils/predictionEngine";
import {
  initAgentPanel,
  renderAgentPanel,
  toggleAgentPanelVisibility,
  setAIThinking,
} from "./agentPanel";
import { createAIProvider } from "@/utils/aiProviderFactory";
import { AI_CONFIG } from "@/config/aiConfig";
import { AIProvider } from "@/types/ai";

// --- Global State ---

let sessionId: string | null = null;
let isRecordingActive = false;
let isAgentGloballyEnabled = true; // Default state, will be updated from storage
let isAgentInitialized = false;

let lastRecordedEvent: (any & { boundingBox?: DOMRect }) | null = null;
let updateTimeout: number | undefined;
let activeFormForAutofill: HTMLFormElement | null = null;
let activeFormFields:
  | {
      name: string;
      id: string;
      type: string;
      placeholder: string;
      labelText: string;
      ariaLabel: string;
    }[]
  | null = null;
let lastHoveredElement: Element | null = null;
let isUpdating = false;
let lastPrediction: PredictionResult | null = null;

let aiProvider: AIProvider | null | undefined = undefined;
let lastAIPredictionTime = 0;
let aiCallCount = 0;
let aiCallResetTime = Date.now();
const AI_COOLDOWN = 15000; // Increased to 15 seconds between AI calls
const MAX_AI_CALLS_PER_MINUTE = 3; // Maximum 3 AI calls per minute
const AI_CALL_RESET_INTERVAL = 60000; // Reset counter every minute

const INTERACTIVE_ELEMENTS = "input, button, a, textarea, select";

// --- Initialization ---

async function init() {
  // Prevent duplicate listeners on script re-injection
  if ((window as any).__flowRecorderListenersAttached) return;

  isRecordingActive = await isRecording();
  sessionId = await getOrCreateSessionId();
  isAgentGloballyEnabled = await isAgentEnabled();

  chrome.runtime.onMessage.addListener(handleMessage);

  document.addEventListener("click", captureInteraction, true);
  document.addEventListener("input", captureInteraction, true);
  document.addEventListener("focusin", captureInteraction, true);
  document.addEventListener("submit", captureInteraction, true);

  if (isAgentGloballyEnabled) {
    initializeAgent();
  }

  if (isRecordingActive) {
    attachRecordingListeners();
  }

  (window as any).__flowRecorderListenersAttached = true;
  console.log("[FlowRecorder] Content script initialized.");
}

// --- Agent Logic ---

function initializeAgent() {
  if (isAgentInitialized) return;

  console.log("[Flow Agent] Initializing...");
  initAgentPanel(onExecutePrediction, scheduleUpdate);
  toggleAgentPanelVisibility(true);
  document.addEventListener("mousemove", handleMouseMove, true);
  updateAgentPredictions();

  isAgentInitialized = true;
}

function decommissionAgent() {
  if (!isAgentInitialized) return;

  console.log("[Flow Agent] Decommissioning...");
  document.removeEventListener("mousemove", handleMouseMove, true);
  toggleAgentPanelVisibility(false);
  // We don't destroy the panel, just hide it, so it can be re-enabled.

  isAgentInitialized = false;
}

async function setAgentState(enabled: boolean) {
  if (enabled === isAgentGloballyEnabled) return;

  isAgentGloballyEnabled = enabled;
  await setAgentEnabled(enabled);

  if (enabled) {
    initializeAgent();
  } else {
    decommissionAgent();
  }
}

/**
 * Lazily initializes and returns the AI provider.
 */
function getAIProvider(): AIProvider | null {
  if (AI_CONFIG.gemini) {
    try {
      return createAIProvider("gemini", AI_CONFIG.gemini);
    } catch (e) {
      console.error("Failed to init Gemini:", e);
    }
  }
  if (AI_CONFIG.chatgpt) {
    try {
      return createAIProvider("chatgpt", AI_CONFIG.chatgpt);
    } catch (e) {
      console.error("Failed to init ChatGPT:", e);
    }
  }
  return null;
}

function throttle<T extends (...args: any[]) => void>(
  func: T,
  limit: number,
): T {
  let inThrottle: boolean;
  return function (this: any, ...args: any[]): void {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  } as T;
}

async function updateAgentPredictions() {
  if (isUpdating || !isAgentGloballyEnabled) return;

  if (aiProvider === undefined) {
    aiProvider = getAIProvider();
  }

  isUpdating = true;
  setAIThinking(true);

  try {
    const context = buildPageContext();
    const deterministic = generatePredictions(context);

    let finalResult = deterministic;

    // Reset AI call counter if a minute has passed
    const now = Date.now();
    if (now - aiCallResetTime > AI_CALL_RESET_INTERVAL) {
      aiCallCount = 0;
      aiCallResetTime = now;
    }

    // Only call AI if:
    // 1. Provider is available
    // 2. Confidence is very low (< 0.2)
    // 3. Cooldown has passed
    // 4. We haven't exceeded the rate limit
    const canCallAI =
      aiProvider &&
      deterministic.confidence < 0.2 &&
      now - lastAIPredictionTime > AI_COOLDOWN &&
      aiCallCount < MAX_AI_CALLS_PER_MINUTE;

    if (canCallAI) {
      lastAIPredictionTime = now;
      aiCallCount++;
      finalResult = await maybeUseAI(context, deterministic, aiProvider);
    }

    if (lastPrediction) {
      const prevTop = lastPrediction.topThree[0]?.action.selector;
      const newTop = finalResult.topThree[0]?.action.selector;
      if (
        prevTop === newTop &&
        Math.abs(finalResult.confidence - lastPrediction.confidence) < 0.05
      ) {
        return; // Prevent flicker
      }
    }

    renderAgentPanel(
      finalResult,
      !!activeFormForAutofill,
      activeFormFields || undefined,
    );
    lastPrediction = finalResult;
  } finally {
    isUpdating = false;
    setAIThinking(false);
  }
}

function scheduleUpdate() {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(updateAgentPredictions, 300); // Increased debounce to 300ms
}

const throttledScheduleUpdate = throttle(scheduleUpdate, 500); // Increased throttle to 500ms

// Throttle mousemove handler itself to reduce frequency
const throttledMouseMove = throttle((event: MouseEvent) => {
  const target = event.target as HTMLElement;
  const interactiveElement = target.closest(INTERACTIVE_ELEMENTS);

  if (!interactiveElement || interactiveElement === lastHoveredElement) {
    return;
  }

  lastHoveredElement = interactiveElement;
  throttledScheduleUpdate();
}, 300); // Throttle mousemove to max once per 300ms

function handleMouseMove(event: MouseEvent) {
  throttledMouseMove(event);
}

function onExecutePrediction(prediction: RankedPrediction) {
  const element = document.querySelector(
    prediction.action.selector,
  ) as HTMLElement;
  if (element) element.click();
  else
    console.error(
      "Could not find element for selector:",
      prediction.action.selector,
    );
}

// --- Event Capture & Core Logic ---

const captureInteraction = async (event: Event) => {
  const target = event.target as HTMLElement;
  if (!target || target.closest("[data-flow-recorder]")) return;

  // Autofill Assist Logic
  if (event.type === "focusin") {
    const form = target.closest("form");
    let newActiveForm: HTMLFormElement | null =
      form &&
      Array.from(form.querySelectorAll("input")).filter((el) => !el.value)
        .length >= 2
        ? form
        : null;

    if (newActiveForm !== activeFormForAutofill) {
      activeFormForAutofill = newActiveForm;
      if (newActiveForm) {
        // Collect more comprehensive field metadata for better autofill matching
        activeFormFields = Array.from(
          newActiveForm.querySelectorAll("input, textarea, select"),
        )
          .filter((el: Element) => {
            const input = el as HTMLInputElement;
            return (
              input.type !== "submit" &&
              input.type !== "button" &&
              input.type !== "hidden" &&
              !input.value
            );
          })
          .map((el: Element) => {
            const input = el as
              | HTMLInputElement
              | HTMLTextAreaElement
              | HTMLSelectElement;
            // Get label text if available
            let labelText = "";
            if (input.id) {
              const label = document.querySelector(`label[for="${input.id}"]`);
              if (label) labelText = label.textContent?.trim() || "";
            }
            if (!labelText) {
              const parentLabel = input.closest("label");
              if (parentLabel)
                labelText = parentLabel.textContent?.trim() || "";
            }
            // aria-label is often used when no <label> exists (e.g. React Hook Form)
            const ariaLabel = input.getAttribute("aria-label")?.trim() || "";

            return {
              name: input.name || "",
              id: input.id || "",
              type:
                input.type ||
                (input.tagName.toLowerCase() === "textarea"
                  ? "textarea"
                  : input.tagName.toLowerCase()),
              placeholder: (input as HTMLInputElement).placeholder || "",
              labelText: labelText,
              ariaLabel: ariaLabel,
            };
          });
      } else {
        activeFormFields = null;
      }
      if (isAgentGloballyEnabled) scheduleUpdate();
    }
  }

  let interactiveElement: HTMLElement | null =
    target.closest(INTERACTIVE_ELEMENTS);
  if (!interactiveElement) return;

  const formElement = interactiveElement.closest("form");
  let parentFormSelector: string | undefined;
  let parentFormIndex: number | undefined;

  if (formElement) {
    parentFormSelector = generateCSSSelector(formElement);
    // Find the index of this form among all forms on the page
    const allForms = Array.from(document.querySelectorAll("form"));
    parentFormIndex = allForms.indexOf(formElement);
    // If form not found in array (shouldn't happen), use -1 as fallback
    if (parentFormIndex === -1) {
      parentFormIndex = undefined;
    }
  }

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: getCurrentRoute(),
    actionType: event.type === "focusin" ? "focus" : event.type,
    elementMetadata: {
      ...extractElementMetadata(interactiveElement),
      value: (interactiveElement as any).value,
      parentForm: parentFormSelector,
      parentFormIndex: parentFormIndex,
    },
    selector: {
      css: generateCSSSelector(interactiveElement),
      xpath: generateXPath(interactiveElement),
    },
    boundingBox: interactiveElement.getBoundingClientRect(),
  };
  lastRecordedEvent = eventData;
  await saveLastUserAction(eventData);

  if (isAgentGloballyEnabled) scheduleUpdate();

  if (isRecordingActive) {
    await saveEvent(eventData as any);
    chrome.runtime
      .sendMessage({ action: "EVENT_RECORDED", event: eventData })
      .catch(() => {});
  }
};

function handleMessage(
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) {
  switch (request.action) {
    case "START_RECORDING":
      startRecording();
      break;
    case "STOP_RECORDING":
      stopRecording();
      break;
    case "TOGGLE_AGENT":
      setAgentState(request.enabled);
      break;
  }
  return true;
}

async function startRecording() {
  if (isRecordingActive) return;
  isRecordingActive = true;
  await setRecordingStatus(true);
  attachRecordingListeners();
}

async function stopRecording() {
  if (!isRecordingActive) return;
  isRecordingActive = false;
  await setRecordingStatus(false);
  detachRecordingListeners();
}

function attachRecordingListeners() {
  /* ... */
}
function detachRecordingListeners() {
  /* ... */
}

function buildPageContext(): PageContext {
  const visibleActions: ActionCandidate[] = [];
  document
    .querySelectorAll('a, button, [role="button"], input[type="submit"]')
    .forEach((el) => {
      const element = el as HTMLElement;
      if (element.closest("[data-flow-recorder]") || !element.innerText.trim())
        return;

      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        visibleActions.push({
          label: element.innerText.trim(),
          selector: generateCSSSelector(element),
          role:
            el.tagName === "BUTTON" ||
            (el as HTMLInputElement).type === "submit"
              ? "primary"
              : "link",
          boundingBox: rect,
          confidenceScore: 0.7,
          formSelector: element.closest("form")
            ? generateCSSSelector(element.closest("form")!)
            : undefined,
        });
      }
    });
  return {
    pageIntent: "unknown", // Simplified for now
    visibleActions: visibleActions.slice(0, 50),
    forms: [],
    lastUserAction: lastRecordedEvent
      ? {
          type: lastRecordedEvent.actionType,
          selector: lastRecordedEvent.selector.css,
          formSelector: lastRecordedEvent.elementMetadata?.parentForm,
        }
      : null,
    lastActionRect: lastRecordedEvent?.boundingBox || null,
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
  };
}

// --- Run ---
init();
