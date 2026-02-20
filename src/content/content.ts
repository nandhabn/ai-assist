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
  saveLastUserAction,
} from "@/utils/storage";
import { ACTION_TYPES } from "@/types/index";
import { createFlyout } from "./flyout";
import "./flyout.css";
import { 
  generatePredictions, 
  maybeUseAI,
  PageContext, 
  ActionCandidate, 
  Form,
  PredictionResult,
  RankedPrediction
} from "@/utils/predictionEngine";
import { initAgentPanel, renderAgentPanel } from "./agentPanel";

// --- Agent Prediction Logic & State ---

import { createAIProvider } from "@/utils/aiProviderFactory";
// ... (other imports)

// --- Agent Prediction Logic & State ---

let lastRecordedEvent: (any & { boundingBox?: DOMRect }) | null = null;
let updateTimeout: number | undefined;
let activeFormForAutofill: HTMLFormElement | null = null;
let activeFormFields: { name: string; type: string }[] | null = null;
let lastHoveredElement: Element | null = null;
let isUpdating = false;

// @Security-Note: In production, the API key should be loaded from chrome.storage and not hardcoded.
const aiProvider = createAIProvider("gemini", "STUB_API_KEY");

// --- Time-based control for performance ---
function throttle<T extends (...args: any[]) => void>(func: T, limit: number): T {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]): void {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    } as T;
}

async function updateAgentPredictions() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const context = buildPageContextForDebugging();
    const deterministic = generatePredictions(context);

    let finalResult = deterministic;
    if (aiProvider) {
      finalResult = await maybeUseAI(context, deterministic, aiProvider);
    }

    console.log("[Agent Update] Confidence:", finalResult.confidence);
    // Pass autofill state to the panel
    renderAgentPanel(finalResult, !!activeFormForAutofill, activeFormFields || undefined);
  } finally {
    isUpdating = false;
  }
}

function scheduleUpdate() {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(updateAgentPredictions, 100);
}

const throttledScheduleUpdate = throttle(scheduleUpdate, 200); // For mousemove

// --- End Agent Logic ---

function inferPageIntent(): string {
    const scores = { authentication: 0.0, search: 0.0, checkout: 0.0 };
    if (document.querySelectorAll('input[type="password"]').length > 0) scores.authentication += 0.6;
    if (document.querySelector('form[action*="/search"]')) scores.search += 0.4;
    if (document.querySelector('[class*="checkout"]')) scores.checkout += 0.4;
    const rankedIntents = Object.entries(scores).filter(([,s])=>s>0).sort(([,a],[,b])=>b-a);
    return rankedIntents.length > 0 ? rankedIntents[0][0] : 'unknown';
}

function buildPageContextForDebugging(): PageContext {
    const visibleActions: ActionCandidate[] = [];
    document.querySelectorAll('a, button, [role="button"], input[type="submit"]').forEach(el => {
        const element = el as HTMLElement;
        if (element.closest('[data-flow-recorder]')) return;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (element.innerText||'').trim()) {
            const parentForm = element.closest('form');
            visibleActions.push({
                label: (element.innerText||'').trim(),
                selector: generateCSSSelector(element),
                role: (el.tagName==='BUTTON'||(el as HTMLInputElement).type==='submit') ? 'primary' : 'link',
                boundingBox: rect,
                confidenceScore: 0.7,
                formSelector: parentForm ? generateCSSSelector(parentForm) : undefined,
            });
        }
    });
    return {
        pageIntent: inferPageIntent(),
        visibleActions: visibleActions.slice(0, 50),
        forms: [],
        lastUserAction: lastRecordedEvent ? {
            type: lastRecordedEvent.actionType,
            selector: lastRecordedEvent.selector.css,
            formSelector: lastRecordedEvent.elementMetadata?.parentForm,
        } : null,
        lastActionRect: lastRecordedEvent?.boundingBox || null,
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    };
}

let sessionId: string | null = null;
let isRecordingActive = false;
const OVERLAY_ID = "__flow_recorder_overlay__";

console.log('[FlowRecorder] Running in development mode');
Object.defineProperty(window, "__lastRecordedEvent", { get:()=>lastRecordedEvent, configurable:true });
// @ts-ignore
window.__debugContextBuilder = () => updateAgentPredictions();

const onExecutePrediction = (prediction: RankedPrediction) => {
  const element = document.querySelector(prediction.action.selector) as HTMLElement;
  if (element) element.click();
  else console.error('Could not find element for selector:', prediction.action.selector);
};

function handleMouseMove(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const interactiveElement = target.closest(INTERACTIVE_ELEMENTS);

  if (!interactiveElement) {
    lastHoveredElement = null;
    return;
  }

  if (interactiveElement !== lastHoveredElement) {
    lastHoveredElement = interactiveElement;
    throttledScheduleUpdate();
  }
}

async function init() {
  isRecordingActive = await isRecording();
  sessionId = await getOrCreateSessionId();
  chrome.runtime.onMessage.addListener(handleMessage as any);

  // Prevent duplicate listeners on script re-injection
  if (!(window as any).__flowRecorderListenersAttached) {
    document.addEventListener("click", captureInteraction, true);
    document.addEventListener("input", captureInteraction, true);
    document.addEventListener("focusin", captureInteraction, true);
    document.addEventListener("submit", captureInteraction, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    (window as any).__flowRecorderListenersAttached = true;
  }

  // Initialize Agent Panel
  initAgentPanel(onExecutePrediction, scheduleUpdate);
  updateAgentPredictions();

  if (isRecordingActive) attachRecordingListeners();
}

function handleMessage(request: any, sendResponse: any) { /* ... existing ... */ }
async function handleRedoAction(event: any): Promise<{ success: boolean; error?: string }> { /* ... existing ... */ return {success: false}; }
async function startRecording() { /* ... existing ... */ }
function attachRecordingListeners() { /* ... existing ... */ }
async function stopRecording() { /* ... existing ... */ }
function detachRecordingListeners() { 'use strict'; }
function analyzePageAndShowFlyout() { /* ... existing ... */ }

const INTERACTIVE_ELEMENTS = "input, button, a, textarea, select";

const captureInteraction = async (event: Event) => {
    const target = event.target as HTMLElement;
    if (!target || target.closest('[data-flow-recorder]')) return;

    // REQUIREMENT 1: AUTOFILL ASSIST LOGIC
    if (event.type === 'focusin') {
        const form = target.closest('form');
        let newActiveForm: HTMLFormElement | null = null;
        let newFormFields: { name: string, type: string }[] | null = null;
    
        if (form) {
            const fillableInputs = Array.from(form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea'));
            const emptyFields = fillableInputs.filter(el => (el as HTMLInputElement).value === '');
            if (
                emptyFields.length >= 2 &&
                !form.querySelector('input[type="search"]') &&
                !form.querySelector('input[name*="otp"]')
            ) {
                newActiveForm = form;
                newFormFields = fillableInputs.map(el => ({
                    name: (el as HTMLInputElement).name,
                    type: (el as HTMLInputElement).type,
                }));
            }
        }
    
        if (newActiveForm !== activeFormForAutofill) {
            activeFormForAutofill = newActiveForm;
            activeFormFields = newFormFields;
            scheduleUpdate();
        }
    }

    let interactiveElement: HTMLElement | null = target.closest(INTERACTIVE_ELEMENTS);
    if (!interactiveElement) return;

    const eventData = {
        sessionId,
        timestamp: Date.now(),
        url: sanitizeURL(window.location.href),
        route: getCurrentRoute(),
        actionType: event.type === 'focusin' ? 'focus' : event.type,
        elementMetadata: {
            ...extractElementMetadata(interactiveElement),
            value: (interactiveElement as any).value,
            parentForm: interactiveElement.closest('form') ? generateCSSSelector(interactiveElement.closest('form')!) : undefined,
        },
        selector: { css: generateCSSSelector(interactiveElement), xpath: generateXPath(interactiveElement) },
        boundingBox: interactiveElement.getBoundingClientRect(),
    };
    lastRecordedEvent = eventData;
    await saveLastUserAction(eventData);

    scheduleUpdate();

    if (isRecordingActive) {
        console.log(`[FlowRecorder] Interaction Recorded:`, { action: eventData.actionType, element: interactiveElement });
        await saveEvent(eventData as any);
        chrome.runtime.sendMessage({ action: "EVENT_RECORDED", event: eventData }).catch(()=>{});
    }
};

const handleRouteChange = async (routeInfo: any) => {
  scheduleUpdate();
  if (!isRecordingActive) return;
  // ... existing event saving logic ...
};

// ... other existing functions (handleAPICall, showRecordingOverlay, etc) ...

init();
