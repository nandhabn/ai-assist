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
import { inferPageIntent } from "@/utils/contextBuilder";
import {
  initAgentPanel,
  renderAgentPanel,
  toggleAgentPanelVisibility,
  setAIThinking,
  showFormDetectedBanner,
  hideFormDetectedBanner,
  setAutofillTargetForm,
} from "./agentPanel";
import { createAIProvider } from "@/utils/aiProviderFactory";
import { AI_CONFIG } from "@/config/aiConfig";
import { AIProvider, FormFieldInfo } from "@/types/ai";

// --- Global State ---

let sessionId: string | null = null;
let isRecordingActive = false;
let isAgentGloballyEnabled = true; // Default state, will be updated from storage
let isAgentInitialized = false;
let hasUserInteracted = false; // Don't fire AI on page load — wait for first real interaction

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

// --- AI Call Logger with timestamp ---
function aiLog(msg: string) {
  const now = new Date();
  const ts = `${now.toLocaleTimeString("en-GB")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  console.log(`[AI Call Log] [${ts}] ${msg}`);
}

// --- Unified AI Rate Limiter ---
// State lives on `window` so all script instances (double-injection) share it
const AI_MIN_INTERVAL = 10000; // 10s minimum between any AI call
const AI_MAX_CALLS_PER_WINDOW = 4; // Max 4 AI calls per window
const AI_WINDOW_DURATION = 120000; // 2-minute sliding window

type RateLimiterState = {
  lastCall: number;
  count: number;
  windowStart: number;
};
function getRLState(): RateLimiterState {
  if (!(window as any).__aiRateLimiter) {
    (window as any).__aiRateLimiter = {
      lastCall: 0,
      count: 0,
      windowStart: Date.now(),
    };
  }
  return (window as any).__aiRateLimiter as RateLimiterState;
}

function canMakeAICall(): boolean {
  const now = Date.now();
  const s = getRLState();
  if (now - s.windowStart > AI_WINDOW_DURATION) {
    s.count = 0;
    s.windowStart = now;
  }
  return (
    now - s.lastCall >= AI_MIN_INTERVAL && s.count < AI_MAX_CALLS_PER_WINDOW
  );
}

function recordAICall() {
  const s = getRLState();
  s.lastCall = Date.now();
  s.count++;
  aiLog(
    `API call recorded | Count this window: ${s.count}/${AI_MAX_CALLS_PER_WINDOW} | Window resets in: ${Math.round((AI_WINDOW_DURATION - (Date.now() - s.windowStart)) / 1000)}s`,
  );
}

// --- Autofill AI Cache ---
// Cache AI-generated form data to avoid redundant calls for the same form
let cachedAutofillData: Record<string, string> | null = null;
let cachedAutofillFieldsKey: string | null = null;
let isAutofillGenerating = false;

const INTERACTIVE_ELEMENTS = "input, button, a, textarea, select";

// --- Initialization ---

async function init() {
  // Only run in the top-level frame, not inside iframes
  if (window !== window.top) return;

  // Prevent duplicate init on script re-injection — set flag SYNCHRONOUSLY before any await
  if ((window as any).__flowRecorderListenersAttached) return;
  (window as any).__flowRecorderListenersAttached = true;

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

  console.log("[FlowRecorder] Content script initialized.");
}

// --- Agent Logic ---

/**
 * Generates autofill data using AI. Falls back to basic generated data
 * if AI is unavailable or the call fails.
 */
async function generateAutofillData(
  fields: FormFieldInfo[],
  retryContext?: {
    fieldErrors: { fieldId: string; fieldName: string; errorText: string }[];
  },
): Promise<Record<string, string>> {
  // Prevent concurrent generation
  if (isAutofillGenerating) {
    console.log(
      "[Flow Agent] Autofill generation already in progress, waiting...",
    );
    // Return cached data if available, otherwise fallback
    return cachedAutofillData || generateBasicFormData(fields);
  }

  // Build a cache key from field identifiers to detect same form
  const fieldsKey = fields.map((f) => `${f.name}|${f.id}|${f.type}`).join(";");

  // On retry, always bust the cache so the AI gets a fresh chance with error context
  if (retryContext?.fieldErrors.length) {
    cachedAutofillData = null;
    cachedAutofillFieldsKey = null;
  }

  // Return cached data if the form hasn't changed (first-fill only)
  if (cachedAutofillData && cachedAutofillFieldsKey === fieldsKey) {
    console.log("[Flow Agent] Returning cached AI form data");
    return cachedAutofillData;
  }

  // Ensure AI provider is initialized
  if (aiProvider === undefined) {
    aiProvider = getAIProvider();
  }

  if (aiProvider && canMakeAICall()) {
    isAutofillGenerating = true;
    try {
      aiLog(
        `Form data AI call triggered | Fields: ${fields.length} | Page: ${document.title || window.location.pathname}`,
      );
      recordAICall();
      console.log("[Flow Agent] Requesting AI-generated form data...");
      const pageContext = document.title || window.location.pathname;
      // When retrying after validation errors, embed the error details so the AI
      // can correct the problematic field values.
      const enrichedContext = retryContext?.fieldErrors.length
        ? `${pageContext}. Previous fill attempt had validation errors — please correct: ` +
          retryContext.fieldErrors
            .map((e) => `"${e.fieldName || e.fieldId}": ${e.errorText}`)
            .join("; ")
        : pageContext;
      const result = await aiProvider.generateFormData(fields, enrichedContext);

      if (result.fieldValues && Object.keys(result.fieldValues).length > 0) {
        aiLog(
          `Form data AI call SUCCESS | Fields generated: ${Object.keys(result.fieldValues).length}`,
        );
        console.log(
          "[Flow Agent] AI-generated form data received:",
          result.fieldValues,
        );

        // Expand the AI-generated data to include multiple key variants
        // so findBestFieldMatch in the form filler can match by name, id, label, etc.
        const expandedData: Record<string, string> = {};
        for (const field of fields) {
          // Find the AI-generated value for this field by checking all identifiers
          const identifiers = [
            field.name,
            field.id,
            field.labelText,
            field.ariaLabel,
            field.placeholder,
          ].filter(Boolean);
          let value: string | undefined;

          for (const key of identifiers) {
            if (result.fieldValues[key]) {
              value = result.fieldValues[key];
              break;
            }
          }

          // Also check normalized keys (lowercased, no separators)
          if (!value) {
            const normalize = (s: string) =>
              (s || "").toLowerCase().replace(/[\s_-]/g, "");
            for (const key of identifiers) {
              const normKey = normalize(key);
              for (const [aiKey, aiVal] of Object.entries(result.fieldValues)) {
                if (normalize(aiKey) === normKey) {
                  value = aiVal;
                  break;
                }
              }
              if (value) break;
            }
          }

          if (!value) continue;

          // Add the value under all available identifiers for robust matching
          for (const id of identifiers) {
            if (id) expandedData[id] = value;
          }
        }

        // Cache the result
        cachedAutofillData = expandedData;
        cachedAutofillFieldsKey = fieldsKey;
        return expandedData;
      }
    } catch (error) {
      aiLog(`Form data AI call FAILED | Error: ${error}`);
      console.warn(
        "[Flow Agent] AI form data generation failed, falling back to basic generator:",
        error,
      );
    } finally {
      isAutofillGenerating = false;
    }
  } else if (!aiProvider) {
    aiLog("Form data AI call SKIPPED (no provider configured)");
    console.log(
      "[Flow Agent] No AI provider available, using basic data generator",
    );
  } else {
    const s = getRLState();
    aiLog(
      `Form data AI call SKIPPED (rate limited) | Calls this window: ${s.count}/${AI_MAX_CALLS_PER_WINDOW} | Cooldown remaining: ${Math.max(0, Math.round((AI_MIN_INTERVAL - (Date.now() - s.lastCall)) / 1000))}s`,
    );
    console.log("[Flow Agent] AI rate limited, using basic data generator");
  }

  // Fallback: generate basic data without AI
  const fallback = generateBasicFormData(fields);
  cachedAutofillData = fallback;
  cachedAutofillFieldsKey = fieldsKey;
  return fallback;
}

/**
 * Basic fallback data generator (used when AI is unavailable).
 * Generates simple test data based on field type heuristics.
 */
function generateBasicFormData(
  fields: FormFieldInfo[],
): Record<string, string> {
  const data: Record<string, string> = {};
  const normalize = (str: string): string =>
    (str || "").toLowerCase().replace(/[\s_-]/g, "");

  const randomString = (len: number) => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(
      { length: len },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  };

  const firstName = "Alex";
  const lastName = "Johnson";
  const email = `alex.johnson${Math.floor(Math.random() * 1000)}@example.com`;
  const password = `Test!${randomString(8)}#1`;
  const phone =
    "+1-555-" +
    Math.floor(Math.random() * 900 + 100) +
    "-" +
    Math.floor(Math.random() * 9000 + 1000);

  for (const field of fields) {
    const hints = [
      field.name,
      field.id,
      field.placeholder,
      field.labelText,
      field.ariaLabel,
    ]
      .map(normalize)
      .join(" ");
    const type = field.type.toLowerCase();

    let value = "";
    if (field.options && field.options.length > 0) {
      // For select/dropdown and radio group fields, pick the first valid option
      value = field.options[0];
    } else if (type === "email" || hints.includes("email")) value = email;
    else if (type === "password" || hints.includes("password"))
      value = password;
    else if (
      type === "tel" ||
      hints.includes("phone") ||
      hints.includes("mobile")
    )
      value = phone;
    else if (hints.includes("firstname") || hints.includes("first"))
      value = firstName;
    else if (hints.includes("lastname") || hints.includes("last"))
      value = lastName;
    else if (hints.includes("name")) value = `${firstName} ${lastName}`;
    else if (type === "number")
      value = String(Math.floor(Math.random() * 10000));
    else if (type === "date") value = "1990-06-15";
    else value = `Test ${randomString(6)}`;

    if (!value) continue;

    const identifiers = [
      field.name,
      field.id,
      field.labelText,
      field.ariaLabel,
      field.placeholder,
    ].filter(Boolean);
    for (const id of identifiers) {
      data[id] = value;
    }
    if (identifiers.length === 0) {
      data[`field_${type}_${fields.indexOf(field)}`] = value;
    }
  }

  return data;
}

function initializeAgent() {
  if (isAgentInitialized) return;

  console.log("[Flow Agent] Initializing...");
  initAgentPanel(onExecutePrediction, scheduleUpdate, generateAutofillData);
  toggleAgentPanelVisibility(true);
  document.addEventListener("mousemove", handleMouseMove, true);
  updateAgentPredictions();
  checkAndShowFormBanner();
  // Re-check after a delay for SPAs that render forms asynchronously
  setTimeout(checkAndShowFormBanner, 1500);
  setTimeout(checkAndShowFormBanner, 4000);

  isAgentInitialized = true;
}

/** Detect forms on the current page and show the banner if any are found. */
function checkAndShowFormBanner() {
  const forms = Array.from(document.querySelectorAll("form")).filter(
    (f) =>
      f.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select",
      ).length >= 1,
  );
  if (forms.length === 0) {
    hideFormDetectedBanner();
    return;
  }
  const formEntries = forms.map((form, index) => {
    // Derive a human-readable label for the form
    const ariaLabel =
      form.getAttribute("aria-label") || form.getAttribute("aria-labelledby");
    const idLabel = form.id ? `#${form.id}` : "";
    const heading = form
      .closest("section, main, article, div")
      ?.querySelector("h1, h2, h3, h4")
      ?.textContent?.trim();
    const submitBtn = form.querySelector<HTMLInputElement | HTMLButtonElement>(
      "button[type=submit], input[type=submit]",
    );
    const submitLabel =
      submitBtn?.textContent?.trim() || submitBtn?.value?.trim();
    const label =
      ariaLabel ||
      (idLabel && idLabel !== "#" ? idLabel : "") ||
      heading ||
      (submitLabel ? `Submit: ${submitLabel}` : "") ||
      `Form ${index + 1}`;

    return {
      label,
      onFocus: () => {
        const firstInput = form.querySelector<HTMLElement>(
          "input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
        );
        if (firstInput) {
          firstInput.scrollIntoView({ behavior: "smooth", block: "center" });
          firstInput.focus();
        } else {
          form.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      },
    };
  });

  showFormDetectedBanner(formEntries);
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
  // ChatGPT Tab provider is tried first — no API key needed, just an open chatgpt.com tab
  try {
    return createAIProvider("chatgpt-tab", "");
  } catch (e) {
    console.warn("ChatGPT Tab unavailable:", e);
  }
  // Fall back to API-key-based providers
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

    // Only call AI if:
    // 1. Provider is available
    // 2. Confidence is very low (< 0.2)
    // 3. User has interacted with the page (not a cold page-load)
    // 4. Unified rate limiter allows it
    if (
      aiProvider &&
      deterministic.confidence < 0.2 &&
      hasUserInteracted &&
      canMakeAICall()
    ) {
      aiLog(
        `Prediction AI call triggered | Confidence: ${deterministic.confidence.toFixed(3)} | Provider: ${AI_CONFIG.gemini ? "Gemini" : AI_CONFIG.chatgpt ? "ChatGPT API" : "ChatGPT Tab"}`,
      );
      recordAICall();
      finalResult = await maybeUseAI(context, deterministic, aiProvider);
      aiLog(
        `Prediction AI call completed | New confidence: ${finalResult.confidence.toFixed(3)}`,
      );
    } else if (
      aiProvider &&
      deterministic.confidence < 0.2 &&
      !hasUserInteracted
    ) {
      aiLog("Prediction AI call SKIPPED (waiting for user interaction)");
    } else if (
      aiProvider &&
      deterministic.confidence < 0.2 &&
      !canMakeAICall()
    ) {
      const s = getRLState();
      aiLog(
        `Prediction AI call SKIPPED (rate limited) | Confidence: ${deterministic.confidence.toFixed(3)} | Calls this window: ${s.count}/${AI_MAX_CALLS_PER_WINDOW} | Cooldown remaining: ${Math.max(0, Math.round((AI_MIN_INTERVAL - (Date.now() - s.lastCall)) / 1000))}s`,
      );
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
  updateTimeout = window.setTimeout(updateAgentPredictions, 600); // 600ms debounce
}

const throttledScheduleUpdate = throttle(scheduleUpdate, 1000); // 1s throttle

// Throttle mousemove handler itself to reduce frequency
const throttledMouseMove = throttle((event: MouseEvent) => {
  hasUserInteracted = true;
  const target = event.target as HTMLElement;
  const interactiveElement = target.closest(INTERACTIVE_ELEMENTS);

  if (!interactiveElement || interactiveElement === lastHoveredElement) {
    return;
  }

  lastHoveredElement = interactiveElement;
  throttledScheduleUpdate();
}, 500); // Throttle mousemove to max once per 500ms

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
  hasUserInteracted = true;
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
      // Keep agentPanel in sync so the fill button always knows which form to target
      setAutofillTargetForm(newActiveForm);
      // Invalidate autofill cache when form changes
      cachedAutofillData = null;
      cachedAutofillFieldsKey = null;
      if (newActiveForm) {
        // Collect more comprehensive field metadata for better autofill matching
        const allElements = Array.from(
          newActiveForm.querySelectorAll("input, textarea, select"),
        );
        // Track radio groups we've already processed
        const processedRadioGroups = new Set<string>();

        activeFormFields = allElements
          .filter((el: Element) => {
            const input = el as HTMLInputElement;
            const type = input.type?.toLowerCase();
            if (type === "submit" || type === "button" || type === "hidden")
              return false;
            // Radio buttons: only process the first one per group name
            if (type === "radio") {
              const groupName = input.name;
              if (!groupName || processedRadioGroups.has(groupName))
                return false;
              processedRadioGroups.add(groupName);
              return true;
            }
            // Checkboxes always have a value; don't filter them by !input.value
            if (type === "checkbox") return !input.checked;
            // For text-like fields, skip if already filled
            return !input.value;
          })
          .map((el: Element) => {
            const input = el as
              | HTMLInputElement
              | HTMLTextAreaElement
              | HTMLSelectElement;
            const type =
              (input as HTMLInputElement).type?.toLowerCase() ||
              (input.tagName.toLowerCase() === "textarea"
                ? "textarea"
                : input.tagName.toLowerCase());
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

            // Capture options for select elements and radio button groups
            let options: string[] | undefined;
            if (input.tagName.toLowerCase() === "select") {
              options = Array.from((input as HTMLSelectElement).options)
                .filter((opt) => opt.value && opt.value !== "" && !opt.disabled)
                .map((opt) => opt.text.trim())
                .slice(0, 20);
            } else if (type === "radio" && (input as HTMLInputElement).name) {
              // Collect all radio options in the group
              const radios = Array.from(
                newActiveForm!.querySelectorAll<HTMLInputElement>(
                  `input[type="radio"][name="${(input as HTMLInputElement).name}"]`,
                ),
              );
              options = radios
                .filter((r) => r.value && !r.disabled)
                .map((r) => {
                  // Try to get a human-readable label for each radio option
                  let radioLabel = "";
                  if (r.id) {
                    const lbl = document.querySelector(`label[for="${r.id}"]`);
                    if (lbl) radioLabel = lbl.textContent?.trim() || "";
                  }
                  if (!radioLabel) {
                    const parentLbl = r.closest("label");
                    if (parentLbl)
                      radioLabel = parentLbl.textContent?.trim() || "";
                  }
                  return radioLabel || r.value;
                })
                .slice(0, 20);
              // Also derive a group-level label from the fieldset legend or surrounding heading
              if (!labelText) {
                const fieldset = input.closest("fieldset");
                const legend = fieldset?.querySelector("legend");
                if (legend) labelText = legend.textContent?.trim() || "";
              }
            }

            return {
              name: input.name || "",
              id: input.id || "",
              type,
              placeholder: (input as HTMLInputElement).placeholder || "",
              labelText: labelText,
              ariaLabel: ariaLabel,
              options,
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
    pageIntent: inferPageIntent(
      window.location.href,
      [],
      visibleActions.slice(0, 50),
    ),
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
