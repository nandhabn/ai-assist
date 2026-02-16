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

let sessionId: string | null = null;
let isRecordingActive = false;
const OVERLAY_ID = "__flow_recorder_overlay__";
let cleanupRouteDetector: (() => void) | null = null;
let cleanupFetchInterceptor: (() => void) | null = null;
let cleanupXHRInterceptor: (() => void) | null = null;

async function init() {
  sessionId = await getOrCreateSessionId();
  isRecordingActive = await isRecording();

  chrome.runtime.onMessage.addListener(handleMessage as any);

  if (isRecordingActive) {
    startRecording();
  }
}

async function handleMessage(request: any, sender: any, sendResponse: any) {
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
      handleRedoAction(request.event).then(sendResponse);
      return true; // Indicates that the response is sent asynchronously

    default:
      sendResponse({ error: "Unknown action" });
  }
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

  showRecordingOverlay();

  setupClickListener();
  setupInputListener();
  setupSubmitListener();

  cleanupRouteDetector = detectRouteChanges(handleRouteChange as any);

  cleanupFetchInterceptor = overrideFetch(handleAPICall as any);
  cleanupXHRInterceptor = overrideXHR(handleAPICall as any);

  console.log("[FlowRecorder] Recording started");
}

async function stopRecording() {
  if (!isRecordingActive) return;

  isRecordingActive = false;
  await setRecordingStatus(false);

  removeRecordingOverlay();

  document.removeEventListener("click", handleClickEvent as any, true);
  document.removeEventListener("input", handleInputEvent as any, true);
  document.removeEventListener("submit", handleSubmitEvent as any, true);

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

  console.log("[FlowRecorder] Recording stopped");
}

function setupClickListener() {
  document.addEventListener("click", handleClickEvent as any, true);
}

const handleClickEvent = async (event: Event) => {
  if (!isRecordingActive) return;

  let elementToRecord: HTMLElement | null = event.target as HTMLElement;

  // Traverse up the DOM to find the first "trackable" element
  while (elementToRecord) {
    if (shouldTrackElement(elementToRecord)) {
      break; // Found our element
    }
    // Stop traversal at the body or if there's no parent
    if (
      !elementToRecord.parentElement ||
      elementToRecord.parentElement === document.body
    ) {
      elementToRecord = null;
      break;
    }
    elementToRecord = elementToRecord.parentElement;
  }

  if (!elementToRecord) return; // Nothing to record

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: getCurrentRoute(),
    actionType: ACTION_TYPES.CLICK,
    elementMetadata: extractElementMetadata(elementToRecord),
    selector: {
      css: generateCSSSelector(elementToRecord),
      xpath: generateXPath(elementToRecord),
    },
  };

  await saveEvent(eventData as any);

  chrome.runtime
    .sendMessage({ action: "EVENT_RECORDED", event: eventData })
    .catch(() => {});
};

function setupInputListener() {
  document.addEventListener("input", handleInputEvent as any, true);
}

const handleInputEvent = async (event: Event) => {
  if (!isRecordingActive) return;

  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const tag = (target.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return;

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: getCurrentRoute(),
    actionType: ACTION_TYPES.INPUT,
    elementMetadata: {
      ...extractElementMetadata(target),
      value: target.value,
      parentForm: getParentForm(target)?.id || null,
    },
    selector: {
      css: generateCSSSelector(target),
      xpath: generateXPath(target),
    },
  };

  await saveEvent(eventData as any);

  chrome.runtime
    .sendMessage({ action: "EVENT_RECORDED", event: eventData })
    .catch(() => {});
};

function setupSubmitListener() {
  document.addEventListener("submit", handleSubmitEvent as any, true);
}

const handleSubmitEvent = async (event: Event) => {
  if (!isRecordingActive) return;

  const target = event.target as HTMLElement;

  const eventData = {
    sessionId,
    timestamp: Date.now(),
    url: sanitizeURL(window.location.href),
    route: getCurrentRoute(),
    actionType: ACTION_TYPES.SUBMIT,
    elementMetadata: {
      ...extractElementMetadata(target),
      formId: (target as HTMLElement).id || null,
    },
    selector: {
      css: generateCSSSelector(target),
      xpath: generateXPath(target),
    },
  };

  await saveEvent(eventData as any);

  chrome.runtime
    .sendMessage({ action: "EVENT_RECORDED", event: eventData })
    .catch(() => {});
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
