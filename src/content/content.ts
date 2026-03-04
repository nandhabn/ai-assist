import { generateCSSSelector } from "@/utils/selectorGenerator";
import {
  getCurrentRoute,
  sanitizeURL,
} from "@/utils/navigationDetector";
import {
  isAgentEnabled,
  setAgentEnabled,
} from "@/utils/storage";
import {
  generatePredictions,
  PageContext,
  ActionCandidate,
  PredictionResult,
  RankedPrediction,
} from "@/utils/predictionEngine";
import { inferPageIntent } from "@/utils/contextBuilder";
import {
  initAgentPanel,
  toggleAgentPanelVisibility,
  setAIThinking,
  showFormDetectedBanner,
  hideFormDetectedBanner,
  setAutofillTargetForm,
  setMissionPrompt,
  updateAgentControlUI,
  appendAgentLogEntry,
  clearAgentLog,
  flashAutoExecution,
  showAgentPlan,
} from "./agentPanel";
import { createAIProvider, createNovaProvider } from "@/utils/aiProviderFactory";
import { buildQueuedProvider, QueuedAIProvider } from "@/utils/aiQueue";
import { getGeminiCallStats, resetGeminiCallStats } from "@/utils/geminiProvider";
import { AI_CONFIG } from "@/config/aiConfig";
import { AIProvider, FormFieldInfo, AgentToolCall, AgentPageElement } from "@/types/ai";
import {
  AgentExecutor,
  AgentStatus,
  AgentStep,
  AgentSession,
} from "@/utils/agentExecutor";
import { buildMissionPlanPrompt } from "@/config/prompts";
import { createCompactContext } from "@/utils/predictionEngine";

// --- Global State ---

let isAgentGloballyEnabled = false;
let isAgentInitialized = false;

let activeFormForAutofill: HTMLFormElement | null = null;
let activeFormFields: FormFieldInfo[] | null = null;

let aiProvider: AIProvider | null | undefined = undefined;

// --- Mission Prompt ---
let currentMission = "";

// --- Agent Executor ---
let agentExecutor: AgentExecutor | null = null;
let isAgentExecutorActive = false;

// --- Navigation / per-page state ---
let currentPageUrl = window.location.href;

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

// --- Initialization ---

async function init() {
  // Only run in the top-level frame, not inside iframes
  if (window !== window.top) return;

  // Prevent duplicate init on script re-injection
  if ((window as any).__flowRecorderListenersAttached) return;
  (window as any).__flowRecorderListenersAttached = true;

  isAgentGloballyEnabled = await isAgentEnabled();

  // Load mission from background for this tab
  try {
    const resp = await chrome.runtime.sendMessage({ action: "GET_MISSION_PROMPT" });
    if (resp?.prompt) {
      currentMission = resp.prompt;
    }
  } catch (_) { /* no-op */ }

  chrome.runtime.onMessage.addListener(handleMessage);

  // Listen for focusin to track form activity for autofill
  document.addEventListener("focusin", captureFormFocus, true);

  // Patch history methods so SPA navigation is detected
  patchHistoryForNavigation();

  if (isAgentGloballyEnabled) {
    initializeAgent();
    // Resume agent across navigation if it was running
    chrome.runtime
      .sendMessage({ action: "GET_AGENT_RUNNING" })
      .then((resp: { running?: boolean } | undefined) => {
        if (resp?.running && currentMission) {
          console.log("[Flow Agent] Resuming agent after navigation...");
          setTimeout(() => handleAgentStart(), 2000);
        }
      })
      .catch(() => {});
  }

  console.log("[Flow Agent] Initialized.");

  (window as any).__flowAgent = {
    geminiStats: () => getGeminiCallStats(),
    resetGeminiStats: () => { resetGeminiCallStats(); console.log("[FlowAgent] Gemini stats reset."); },
    rlState: () => getRLState(),
    agentActive: () => isAgentExecutorActive,
    agentSession: () => agentExecutor?.getSession() ?? null,
  };
  console.log("[FlowAgent] Debug helpers available via window.__flowAgent");
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
      // Include mission in the context if set
      const missionPrefix = currentMission
        ? `User mission: ${currentMission}. `
        : "";
      // When retrying after validation errors, embed the error details so the AI
      // can correct the problematic field values.
      const enrichedContext = retryContext?.fieldErrors.length
        ? `${missionPrefix}${pageContext}. Previous fill attempt had validation errors — please correct: ` +
          retryContext.fieldErrors
            .map((e) => `"${e.fieldName || e.fieldId}": ${e.errorText}`)
            .join("; ")
        : `${missionPrefix}${pageContext}`;
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

          // Store under a single canonical key so the form filler doesn't
          // try to fill the same logical field multiple times.
          // Priority: id → name → labelText → ariaLabel → placeholder
          const canonicalKey =
            field.id || field.name || field.labelText || field.ariaLabel || field.placeholder;
          if (canonicalKey) expandedData[canonicalKey] = value;
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
  initAgentPanel(
    () => { /* manual prediction execution not used in tool-call mode */ },
    () => { /* no prediction refresh — agent drives its own loop */ },
    generateAutofillData,
    {
      onStart: handleAgentStart,
      onStop: handleAgentStop,
      onPause: handleAgentPause,
      onResume: handleAgentResume,
    },
  );
  toggleAgentPanelVisibility(true);
  checkAndShowFormBanner();
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
  toggleAgentPanelVisibility(false);
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
 * Builds a QueuedAIProvider chain so requests are serialised and providers
 * fail over automatically when a 429 / quota error is returned.
 */
function getAIProvider(): QueuedAIProvider | null {
  const chain: ReturnType<typeof createAIProvider>[] = [];

  // Priority order: ChatGPT API → Nova → Gemini → ChatGPT Tab (only if enabled)
  if (AI_CONFIG.chatgpt) {
    try { chain.push(createAIProvider("chatgpt", AI_CONFIG.chatgpt)); }
    catch (e) { console.error("Failed to init ChatGPT:", e); }
  }
  if (AI_CONFIG.novaConfig) {
    try { chain.push(createNovaProvider(AI_CONFIG.novaConfig)); }
    catch (e) { console.error("Failed to init Amazon Nova:", e); }
  }
  if (AI_CONFIG.gemini) {
    try { chain.push(createAIProvider("gemini", AI_CONFIG.gemini)); }
    catch (e) { console.error("Failed to init Gemini:", e); }
  }
  if (AI_CONFIG.chatgptTab) {
    try { chain.push(createAIProvider("chatgpt-tab", "")); }
    catch (e) { console.warn("ChatGPT Tab unavailable:", e); }
  }

  if (chain.length === 0) return null;
  return buildQueuedProvider(chain);
}



/**
 * Called whenever the page URL changes (SPA navigation or hard nav).
 * Resets per-page state and re-checks for forms on the new page.
 */
function onPageNavigate(newUrl: string): void {
  if (newUrl === currentPageUrl) return;

  console.log(`[FlowAgent] Navigation detected: ${currentPageUrl} → ${newUrl}`);

  activeFormForAutofill = null;
  activeFormFields = null;
  currentPageUrl = newUrl;

  if (isAgentInitialized) {
    setTimeout(checkAndShowFormBanner, 500);
  }
}

/**
 * Patches history.pushState / history.replaceState and listens to popstate
 * so onPageNavigate() fires for every SPA route change.
 * Safe to call multiple times — skips if already patched.
 */
function patchHistoryForNavigation(): void {
  if ((window as any).__flowAgentNavPatched) return;
  (window as any).__flowAgentNavPatched = true;

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    originalPushState(...args);
    onPageNavigate(window.location.href);
  };

  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    originalReplaceState(...args);
    onPageNavigate(window.location.href);
  };

  window.addEventListener("popstate", () => {
    onPageNavigate(window.location.href);
  });

  console.log("[FlowAgent] Navigation listener attached.");
}

/**
 * Finds an interactive element on the page whose visible label matches the given string.
 * Searches buttons, links, inputs, selects, textareas — trying:
 *   1. Exact aria-label / title / placeholder match
 *   2. Exact textContent match
 *   3. Case-insensitive substring match
 * Returns the best match or null.
 */
function findElementByLabel(label: string): HTMLElement | null {
  const needle = label.toLowerCase().trim();
  const selectors = [
    'button', 'a', 'input:not([type=hidden])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="option"]', '[tabindex]',
  ].join(",");

  const all = Array.from(document.querySelectorAll<HTMLElement>(selectors))
    .filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && (el.offsetWidth > 0 || el.offsetHeight > 0);
    });

  const text = (el: HTMLElement) =>
    (el.getAttribute("aria-label") ?? el.getAttribute("title") ??
     el.getAttribute("placeholder") ?? el.textContent ?? "").toLowerCase().trim();

  return (
    all.find((el) => text(el) === needle) ??
    all.find((el) => text(el).startsWith(needle)) ??
    all.find((el) => text(el).includes(needle)) ??
    null
  );
}

/**
 * Executes an AgentToolCall returned by the AI's tool-calling mode.
 * Returns true if the action succeeded, false if it failed or the tool is "done".
 */
async function executeAgentToolCall(toolCall: AgentToolCall): Promise<boolean> {
  const { tool, params } = toolCall;
  console.log(`[Agent Tool] ${tool}`, params);

  switch (tool) {
    case "navigate": {
      if (!params.url) {
        console.error("[Agent Tool] navigate: missing url");
        return false;
      }
      window.location.href = params.url;
      return true;
    }

    case "click": {
      const label = params.label ?? "";
      const el = findElementByLabel(label);
      if (el) {
        el.scrollIntoView({ behavior: "instant", block: "center" });
        await new Promise<void>((r) => setTimeout(r, 80));
        el.click();
        return true;
      }
      // Fallback: navigate via <a> href if element not found via DOM query
      const href = findNavHrefByLabel(label);
      if (href) {
        console.log(`[Agent Tool] click fallback via href: ${href}`);
        window.location.href = href;
        return true;
      }
      console.warn(`[Agent Tool] click: no element found for label "${label}"`);
      return false;
    }

    case "type": {
      const label = params.label ?? "";
      const text = params.text ?? "";
      const el = findElementByLabel(label) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) {
        console.warn(`[Agent Tool] type: no element found for label "${label}"`);
        return false;
      }
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.focus();
      await new Promise<void>((r) => setTimeout(r, 150));

      const tag = el.tagName.toLowerCase();
      const proto = tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;

      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise<void>((r) => setTimeout(r, 300));

      const enterOpts: KeyboardEventInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
      el.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
      el.dispatchEvent(new KeyboardEvent("keyup", enterOpts));
      return true;
    }

    case "scroll": {
      const amount = params.direction === "up" ? -600 : 600;
      window.scrollBy({ top: amount, behavior: "smooth" });
      return true;
    }

    case "done": {
      // "done" is handled by predictForAgentWithTools returning empty topThree.
      // If it somehow reaches execute, log it and return false so the loop exits.
      console.log(`[Agent Tool] done — ${params.reason ?? "mission complete"}`);
      return false;
    }

    default:
      console.error(`[Agent Tool] unknown tool: ${tool}`);
      return false;
  }
}

/**
 * Execute a prediction and return whether the element was found and actioned.
 * Handles both CLICK and TYPE actions:
 *   - If prediction.inputText is set and the target is an input/textarea, types the
 *     text using native value setters (works with React/Vue controlled inputs) and
 *     dispatches Enter to submit (e.g. search bars).
 *   - Otherwise falls back to element.click().
 */
/**
 * Extracts a navigation URL from an AI prediction label or a plan step text.
 * Returns null if no URL is found.
 *
 * Handles patterns like:
 *   "Navigate to https://www.apple.com"
 *   "Go to https://www.apple.com"
 *   "Open https://www.apple.com"
 *   Bare "https://www.apple.com"
 */
function extractNavigationUrl(
  label: string,
  plan?: string,
  currentPlanStep?: number,
): string | null {
  const urlRe = /https?:\/\/[^\s"'>)]+/;

  // 1. Check the AI label directly
  const labelMatch = label.match(urlRe);
  if (labelMatch) return labelMatch[0];

  const lcLabel = label.toLowerCase();
  const isNavIntent =
    lcLabel.startsWith("navigate") ||
    lcLabel.startsWith("go to") ||
    lcLabel.startsWith("open") ||
    lcLabel.startsWith("visit") ||
    lcLabel.includes("navigate to");

  // 2. If the label signals navigation, try to read the URL from the current plan step
  if (isNavIntent && plan && currentPlanStep != null) {
    const lines = plan.split("\n");
    const stepPatterns = [
      new RegExp(`^\\s*${currentPlanStep}[.):]?\\s`, "i"),
      new RegExp(`step\\s*${currentPlanStep}[.):]?\\s`, "i"),
    ];
    for (const line of lines) {
      if (stepPatterns.some((re) => re.test(line))) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
    // Fallback: first plan line containing a nav verb + URL
    for (const line of lines) {
      if (/navigate|go to|open|visit/i.test(line)) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
  }

  return null;
}

/**
 * Given a label string, finds the best matching <a> element on the page and returns
 * its resolved href, or null if nothing useful is found.
 * Matching priority: exact text → starts-with → includes (all case-insensitive).
 */
function findNavHrefByLabel(label: string): string | null {
  const needle = label.toLowerCase().trim();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  // Filter out javascript: and # anchors that don't actually navigate
  const valid = anchors.filter((a) => {
    const h = a.getAttribute("href") ?? "";
    return h && !h.startsWith("#") && !h.startsWith("javascript:");
  });

  // Rank candidates — exact match wins, then startsWith, then includes
  const exact   = valid.find((a) => (a.textContent ?? "").toLowerCase().trim() === needle);
  if (exact) return exact.href;
  const starts  = valid.find((a) => (a.textContent ?? "").toLowerCase().trim().startsWith(needle));
  if (starts) return starts.href;
  const includes = valid.find((a) => (a.textContent ?? "").toLowerCase().includes(needle));
  if (includes) return includes.href;

  // Also check aria-label and title attributes
  const attrMatch = valid.find((a) =>
    [(a.getAttribute("aria-label") ?? "").toLowerCase(),
     (a.getAttribute("title") ?? "").toLowerCase()].some(
      (v) => v === needle || v.includes(needle)
    )
  );
  return attrMatch ? attrMatch.href : null;
}

async function executeForAgent(prediction: RankedPrediction): Promise<boolean> {
  // ── Agent tool-call sentinel ──────────────────────────────────────────────
  // predictForAgentWithTools encodes the full AgentToolCall as the selector.
  if (prediction.action.selector.startsWith("__tool__:")) {
    const toolCall: AgentToolCall = JSON.parse(
      prediction.action.selector.slice("__tool__:".length),
    );
    return executeAgentToolCall(toolCall);
  }

  const element = document.querySelector(
    prediction.action.selector,
  ) as HTMLElement | null;
  if (!element) {
    console.warn(
      "[Agent] Could not find element for selector:",
      prediction.action.selector,
      "— attempting URL navigation fallback",
    );

    // Try to navigate via the browser API if a matching anchor href can be found
    const navHref = findNavHrefByLabel(prediction.action.label);
    if (navHref) {
      console.log(`[Agent] Navigating via window.location to: ${navHref}`);
      window.location.href = navHref;
      return true;
    }

    console.error("[Agent] Navigation fallback failed — no matching link found for label:", prediction.action.label);
    return false;
  }

  // Scroll the element into view synchronously
  element.scrollIntoView({ behavior: "instant", block: "center" });

  const tag = element.tagName.toLowerCase();
  const isTypeable = tag === "input" || tag === "textarea";
  const inputText = prediction.inputText;

  if (isTypeable && inputText) {
    // ── TYPE action ─────────────────────────────────────────────────────────
    element.focus();
    await new Promise<void>((r) => setTimeout(r, 150));

    // Use the native property setter so React/Vue/Angular controlled inputs
    // detect the change and update their internal state.
    const proto =
      tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(element, inputText);
    } else {
      (element as HTMLInputElement).value = inputText;
    }

    // Dispatch events so frameworks (React synthetic events, Angular, etc.) pick up the change
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: inputText }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((r) => setTimeout(r, 300));

    // Simulate pressing Enter — standard way to submit search bars
    const enterOpts: KeyboardEventInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
    element.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
    element.dispatchEvent(new KeyboardEvent("keyup", enterOpts));

    console.log(`[Agent] Typed "${inputText}" into ${prediction.action.selector} and pressed Enter`);
    await new Promise<void>((r) => setTimeout(r, 100));
    return true;
  }

  // ── CLICK action ─────────────────────────────────────────────────────────
  element.click();

  // Brief gap so any synchronous JS handlers (e.g. SPA routers) can run
  await new Promise<void>((r) => setTimeout(r, 100));
  return true;
}

/**
 * Gathers all interactive elements currently visible on the page and returns
 * them as a flat AgentPageElement list for the tool-call prompt.
 * Capped at 40 elements to keep the prompt within token budget.
 */
function buildPageElements(): AgentPageElement[] {
  const results: AgentPageElement[] = [];
  const seen = new Set<string>();

  const add = (label: string, type: AgentPageElement["type"]) => {
    const key = `${type}:${label}`;
    if (!label || label.length < 2 || seen.has(key)) return;
    seen.add(key);
    results.push({ label, type });
  };

  // Buttons
  document.querySelectorAll<HTMLElement>(
    'button, [role="button"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"]',
  ).forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80);
    add(label, "button");
  });

  // Links
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80);
    add(label, "link");
  });

  // Inputs
  document.querySelectorAll<HTMLInputElement>(
    'input:not([type=hidden]):not([type=submit]):not([type=button])',
  ).forEach((el) => {
    const label = (
      el.getAttribute("aria-label") ??
      el.getAttribute("placeholder") ??
      el.getAttribute("name") ?? ""
    ).trim().slice(0, 80);
    add(label || `input[${el.type}]`, "input");
  });

  // Textareas
  document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el) => {
    const label = (el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "textarea").trim().slice(0, 80);
    add(label, "textarea");
  });

  // Selects
  document.querySelectorAll<HTMLSelectElement>("select").forEach((el) => {
    const labelEl = el.id ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`) : null;
    const label = (el.getAttribute("aria-label") ?? labelEl?.textContent ?? el.name ?? "select").trim().slice(0, 80);
    add(label, "select");
  });

  return results.slice(0, 40);
}

/**
 * Tool-call based prediction for agent mode.
 * Calls AIProvider.callAgentTool() which returns a structured AgentToolCall
 * (navigate / click / type / scroll / done) instead of a fuzzy label prediction.
 * The tool call is encoded as a __tool__: selector so no DOM label-matching is needed.
 */
async function predictForAgentWithTools(provider: AIProvider): Promise<PredictionResult> {
  const context = buildPageContext();
  const compactContext = createCompactContext(context);

  // Attach step history, plan, current step, rich element list, and URL
  if (agentExecutor) {
    const session = agentExecutor.getSession();
    compactContext.stepHistory = agentExecutor.getSteps().map((s) => ({
      action: s.action,
      pageUrl: s.pageUrl,
    }));
    if (session?.plan) {
      compactContext.plan = session.plan;
      const completedSteps = agentExecutor.getStepCount();
      const estimatedSteps = session.estimatedSteps ?? 99;
      compactContext.currentPlanStep = Math.min(completedSteps + 1, estimatedSteps);
    }
  }
  compactContext.pageElements = buildPageElements();
  compactContext.currentUrl = window.location.href;

  let toolCall: AgentToolCall;
  try {
    toolCall = await provider.callAgentTool!(compactContext);
  } catch (err) {
    console.error("[Agent] callAgentTool failed:", err);
    throw err;
  }

  // "done" tool → empty result so the loop exits cleanly
  if (toolCall.tool === "done") {
    console.log(`[Agent] Tool=done — ${toolCall.params.reason ?? "mission complete"}`);
    return { topThree: [], confidence: 0 };
  }

  const neutralBreakdown = {
    proximityScore: 0.5, intentScore: 0.5, formScore: 0.5,
    roleScore: 0.5, directionScore: 0.5,
  };
  const score = Math.max(toolCall.confidenceEstimate ?? 0.5, 0.5);

  return {
    topThree: [{
      action: {
        label: `[${toolCall.tool}] ${JSON.stringify(toolCall.params)}`,
        selector: `__tool__:${JSON.stringify(toolCall)}`,
        role: "primary" as const,
        boundingBox: new DOMRect(),
        confidenceScore: score,
      },
      totalScore: score,
      breakdown: neutralBreakdown,
      inputText: toolCall.params.text,
    }],
    confidence: score,
  };
}

/**
 * Prediction function for agent mode.
 * Always uses AI (bypasses rate limiter and confidence threshold)
 * to get mission-aware predictions.
 */
async function predictForAgent(): Promise<PredictionResult> {
  if (aiProvider === undefined) {
    aiProvider = getAIProvider();
  }

  // ── Tool-calling path (preferred) ─────────────────────────────────────────
  // If the provider implements callAgentTool(), use structured tool calls instead
  // of the old label-prediction + fuzzy-match flow. This eliminates "Skip to main
  // content" style hallucinations by giving the AI typed tools with explicit params.
  if (aiProvider && typeof aiProvider.callAgentTool === "function") {
    return predictForAgentWithTools(aiProvider);
  }

  const context = buildPageContext();
  const deterministic = generatePredictions(context);

  // If no AI provider, fall back to deterministic
  if (!aiProvider) {
    return deterministic;
  }

  // Build compact context (includes mission) for the AI provider
  const compactContext = createCompactContext(context);

  // Attach step history, plan, and current plan step so the AI stays on track
  if (agentExecutor) {
    const session = agentExecutor.getSession();
    compactContext.stepHistory = agentExecutor.getSteps().map((s) => ({
      action: s.action,
      pageUrl: s.pageUrl,
    }));
    if (session?.plan) {
      compactContext.plan = session.plan;
      // Next plan step = completed steps + 1 (capped at estimatedSteps)
      const completedSteps = agentExecutor.getStepCount();
      const estimatedSteps = session.estimatedSteps ?? 99;
      compactContext.currentPlanStep = Math.min(completedSteps + 1, estimatedSteps);
    }
  }

  try {
    // Call AI — the provider uses the mission from compactContext in the prompt
    const aiResult = await aiProvider.predictNextAction(compactContext);

    // Check for mission-complete signal — only an explicit MISSION_COMPLETE label
    // (or a zero-confidence response with NO action label) counts as done.
    // A confidence of 0 alone is NOT enough, since truncated JSON repairs also
    // produce confidence=0 but still carry a valid predictedActionLabel.
    if (
      aiResult.predictedActionLabel === "MISSION_COMPLETE" ||
      (aiResult.confidenceEstimate === 0 && !aiResult.predictedActionLabel)
    ) {
      console.log("[Agent] AI indicates mission complete:", aiResult.reasoning);
      return { topThree: [], confidence: 0 };
    }

    // Match AI choice to a deterministic prediction for the selector
    const matchedIndex = deterministic.topThree.findIndex(
      (p) =>
        p.action.label.toLowerCase() ===
        aiResult.predictedActionLabel.toLowerCase(),
    );

    if (matchedIndex >= 0) {
      const matched = deterministic.topThree[matchedIndex];
      const boosted: RankedPrediction = {
        ...matched,
        totalScore: Math.max(matched.totalScore, aiResult.confidenceEstimate),
        inputText: aiResult.inputText,
      };
      const rest = deterministic.topThree.filter((_, i) => i !== matchedIndex);
      return {
        topThree: [boosted, ...rest].slice(0, 3),
        confidence: aiResult.confidenceEstimate,
      };
    }

    // Fuzzy match — AI label might be a substring
    const fuzzyMatch = deterministic.topThree.find((p) =>
      p.action.label
        .toLowerCase()
        .includes(aiResult.predictedActionLabel.toLowerCase()) ||
      aiResult.predictedActionLabel
        .toLowerCase()
        .includes(p.action.label.toLowerCase()),
    );

    if (fuzzyMatch) {
      const boosted: RankedPrediction = {
        ...fuzzyMatch,
        totalScore: Math.max(
          fuzzyMatch.totalScore,
          aiResult.confidenceEstimate,
        ),
        inputText: aiResult.inputText,
      };
      const rest = deterministic.topThree.filter((p) => p !== fuzzyMatch);
      return {
        topThree: [boosted, ...rest].slice(0, 3),
        confidence: aiResult.confidenceEstimate,
      };
    }

    // AI chose something we can't map in top-3 — try ALL visible actions
    // (input fields rank lower and may not appear in the top-3 deterministic set)
    const broadMatch = context.visibleActions.find(
      (a) =>
        a.label.toLowerCase() === aiResult.predictedActionLabel.toLowerCase() ||
        a.label.toLowerCase().includes(aiResult.predictedActionLabel.toLowerCase()) ||
        aiResult.predictedActionLabel.toLowerCase().includes(a.label.toLowerCase()),
    );
    if (broadMatch) {
      const neutralBreakdown = { proximityScore: 0.5, intentScore: 0.5, formScore: 0.5, roleScore: 0.5, directionScore: 0.5 };
      console.log("[Agent] AI prediction matched via broad search:", broadMatch.label);
      return {
        topThree: [{
          action: broadMatch,
          totalScore: aiResult.confidenceEstimate,
          breakdown: neutralBreakdown,
          inputText: aiResult.inputText,
        }],
        confidence: aiResult.confidenceEstimate,
      };
    }

    // Still no match — check if the AI label or the current plan step encodes a URL.
    // This handles "Navigate to https://www.apple.com" when the page has no DOM elements.
    const navigateUrl = extractNavigationUrl(
      aiResult.predictedActionLabel,
      compactContext.plan,
      compactContext.currentPlanStep,
    );
    if (navigateUrl) {
      console.log("[Agent] No DOM match — synthesising navigation action to:", navigateUrl);
      const neutralBreakdown = {
        proximityScore: 0.5, intentScore: 0.5, formScore: 0.5,
        roleScore: 0.5, directionScore: 0.5,
      };
      // Use at least 0.5 so the confidence gate in the loop never blocks a nav step
      const navScore = Math.max(aiResult.confidenceEstimate, 0.5);
      return {
        topThree: [{
          action: {
            label: `Navigate to ${navigateUrl}`,
            selector: `__navigate__:${navigateUrl}`,
            role: "link" as const,
            boundingBox: new DOMRect(),
            confidenceScore: navScore,
          },
          totalScore: navScore,
          breakdown: neutralBreakdown,
          inputText: undefined,
        }],
        confidence: navScore,
      };
    }

    // Still no match — fall back to deterministic
    console.warn(
      "[Agent] AI prediction didn't match any visible action, using deterministic",
    );
    return deterministic;
  } catch (err) {
    console.error("[Agent] AI prediction failed, using deterministic:", err);
    return deterministic;
  }
}

/**
 * Detect forms on the page for agent auto-fill.
 */
function detectFormForAgent(): {
  detected: boolean;
  fields: FormFieldInfo[];
  form: HTMLFormElement | null;
} {
  const forms = Array.from(document.querySelectorAll("form")).filter(
    (f) =>
      f.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select",
      ).length >= 1,
  );

  if (forms.length === 0) {
    return { detected: false, fields: [], form: null };
  }

  // Pick the first form with empty fields
  for (const form of forms) {
    const emptyInputs = Array.from(
      form.querySelectorAll<HTMLInputElement>(
        "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea",
      ),
    ).filter((input) => !input.value);

    if (emptyInputs.length >= 2) {
      // Build field metadata for this form
      const allElements = Array.from(
        form.querySelectorAll("input, textarea, select"),
      );
      const processedRadioGroups = new Set<string>();
      const fields: FormFieldInfo[] = allElements
        .filter((el) => {
          const input = el as HTMLInputElement;
          const type = input.type?.toLowerCase();
          if (type === "submit" || type === "button" || type === "hidden")
            return false;
          if (type === "radio") {
            if (!input.name || processedRadioGroups.has(input.name)) return false;
            processedRadioGroups.add(input.name);
            return true;
          }
          if (type === "checkbox") return !input.checked;
          return !input.value;
        })
        .map((el) => {
          const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const type =
            (input as HTMLInputElement).type?.toLowerCase() ||
            (input.tagName.toLowerCase() === "textarea"
              ? "textarea"
              : input.tagName.toLowerCase());
          let labelText = "";
          if (input.id) {
            const label = document.querySelector(`label[for="${input.id}"]`);
            if (label) labelText = label.textContent?.trim() || "";
          }
          if (!labelText) {
            const parentLabel = input.closest("label");
            if (parentLabel) labelText = parentLabel.textContent?.trim() || "";
          }
          const ariaLabel = input.getAttribute("aria-label")?.trim() || "";

          let options: string[] | undefined;
          if (input.tagName.toLowerCase() === "select") {
            options = Array.from((input as HTMLSelectElement).options)
              .filter((opt) => opt.value && opt.value !== "" && !opt.disabled)
              .map((opt) => opt.text.trim())
              .slice(0, 20);
          } else if (type === "radio" && (input as HTMLInputElement).name) {
            const radios = Array.from(
              form.querySelectorAll<HTMLInputElement>(
                `input[type="radio"][name="${(input as HTMLInputElement).name}"]`,
              ),
            );
            options = radios
              .filter((r) => r.value && !r.disabled)
              .map((r) => {
                let radioLabel = "";
                if (r.id) {
                  const lbl = document.querySelector(`label[for="${r.id}"]`);
                  if (lbl) radioLabel = lbl.textContent?.trim() || "";
                }
                if (!radioLabel) {
                  const parentLbl = r.closest("label");
                  if (parentLbl) radioLabel = parentLbl.textContent?.trim() || "";
                }
                return radioLabel || r.value;
              })
              .slice(0, 20);
          }

          return {
            name: input.name || "",
            id: input.id || "",
            type,
            placeholder: (input as HTMLInputElement).placeholder || "",
            labelText,
            ariaLabel,
            options,
          };
        });

      return { detected: true, fields, form };
    }
  }

  return { detected: false, fields: [], form: null };
}

/**
 * Fill a form using AI-generated data. Used by the agent executor.
 */
async function fillFormForAgent(fields: FormFieldInfo[]): Promise<boolean> {
  try {
    const data = await generateAutofillData(fields);
    if (!data || Object.keys(data).length === 0) return false;

    // Find the form element that contains these fields
    const formInfo = detectFormForAgent();
    if (formInfo.form && (window as any).__fillFormElement) {
      await (window as any).__fillFormElement(formInfo.form, data, {
        debug: true,
        delay: 50,
      });
    } else if ((window as any).__fillActiveForm) {
      await (window as any).__fillActiveForm(data, { debug: true, delay: 50 });
    }
    return true;
  } catch (err) {
    console.error("[Agent] Form fill failed:", err);
    return false;
  }
}

/**
 * Call AI to produce a step-by-step plan for the current mission.
 * Returns { plan, estimatedSteps } parsed from the model response.
 */
async function planMission(mission: string): Promise<{ plan: string; estimatedSteps?: number }> {
  const provider = aiProvider || getAIProvider();
  if (!provider) return { plan: "No AI provider available." };

  const pageTitle = document.title;
  const pageUrl = window.location.href;
  const visibleActions = Array.from(
    document.querySelectorAll<HTMLElement>("a, button, [role='button'], input, select, textarea")
  )
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .slice(0, 30)
    .map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName)
    .filter(Boolean) as string[];

  const prompt = buildMissionPlanPrompt(mission, pageTitle, pageUrl, visibleActions);

  try {
    // Embed the planning prompt as the labelText of a single field so the AI receives the full instruction
    const planField: FormFieldInfo = {
      name: "plan",
      id: "plan",
      type: "text",
      placeholder: "step-by-step plan as JSON",
      labelText: prompt,
      ariaLabel: "mission plan",
    };
    const result = await provider.generateFormData([planField], `Mission planning for: ${mission}`);
    const raw = result.fieldValues["plan"] ?? "";
    try {
      const parsed = JSON.parse(raw) as { plan?: string; estimatedSteps?: number };
      return { plan: parsed.plan ?? raw, estimatedSteps: parsed.estimatedSteps };
    } catch {
      return { plan: raw };
    }
  } catch (e) {
    console.warn("[Agent] planMission failed:", e);
    return { plan: "Planning failed — proceeding without a pre-defined plan." };
  }
}

/**
 * Persist an agent session to chrome.storage.local.
 * Keeps the last 20 sessions under the "agentSessionIndex" key.
 */
async function saveAgentSession(session: AgentSession): Promise<void> {
  try {
    const key = session.id;
    const indexData = await chrome.storage.local.get("agentSessionIndex");
    const index: string[] = (indexData["agentSessionIndex"] as string[]) || [];
    if (!index.includes(key)) {
      index.push(key);
      // Keep only the latest 20 sessions
      if (index.length > 20) index.splice(0, index.length - 20);
    }
    await chrome.storage.local.set({ [key]: session, agentSessionIndex: index });
    console.log(`[Agent] Session saved: ${key} (${session.status})`);
  } catch (e) {
    console.warn("[Agent] Failed to save session:", e);
  }
}

/**
 * Create or get the agent executor instance.
 */
function getOrCreateAgentExecutor(): AgentExecutor {
  if (!agentExecutor) {
    agentExecutor = new AgentExecutor({
      predict: predictForAgent,
      execute: executeForAgent,
      detectForm: detectFormForAgent,
      fillForm: fillFormForAgent,
      planMission: (mission: string) => planMission(mission),
      onSessionSave: (session: AgentSession) => { saveAgentSession(session); },
      onStatusChange: (status: AgentStatus, stepCount: number, message?: string) => {
        isAgentExecutorActive = status === "running" || status === "paused" || status === "planning";

        // Hide the "Suggested Actions" flyout while the agent is active so it
        // doesn't show stale predictions during autonomous execution.
        const flyout = document.getElementById("flow-recorder-flyout");
        if (flyout) flyout.style.display = isAgentExecutorActive ? "none" : "";

        updateAgentControlUI(status, stepCount, message);
        console.log(`[Agent] Status: ${status} | Steps: ${stepCount}${message ? ` | ${message}` : ""}`);
        // Show plan in panel when agent transitions out of planning into running
        if (status === "running" && agentExecutor) {
          const session = agentExecutor.getSession();
          if (session?.plan) {
            showAgentPlan(session.plan);
          }
        }
        // Persist running state to background for cross-navigation resumption
        chrome.runtime.sendMessage({
          action: "SET_AGENT_RUNNING",
          running: isAgentExecutorActive,
        }).catch(() => {});
      },
      onStepComplete: (step: AgentStep) => {
        appendAgentLogEntry(step);
        flashAutoExecution();
      },
    }, {
      // The tool-calling path handles form input via explicit "type" tool calls.
      // Disable automatic form detection/fill so the AI drives all interactions.
      autoFillForms: false,
    });
  }
  return agentExecutor;
}

function handleAgentStart() {
  if (!currentMission) {
    console.warn("[Agent] Cannot start without a mission. Set a mission prompt first.");
    updateAgentControlUI("error", 0, "Set a mission first");
    return;
  }
  const executor = getOrCreateAgentExecutor();
  clearAgentLog();
  executor.start(currentMission);
}

function handleAgentStop() {
  agentExecutor?.stop();
}

function handleAgentPause() {
  agentExecutor?.pause();
}

function handleAgentResume() {
  agentExecutor?.resume();
}

// --- Event Capture & Core Logic ---

async function captureFormFocus(event: Event) {
  const target = event.target as HTMLElement;
  if (!target || target.closest("[data-flow-recorder]")) return;

  if (event.type === "focusin") {
    const form = target.closest("form");
    const newActiveForm: HTMLFormElement | null =
      form &&
      Array.from(form.querySelectorAll("input")).filter((el) => !el.value)
        .length >= 2
        ? form
        : null;

    if (newActiveForm !== activeFormForAutofill) {
      activeFormForAutofill = newActiveForm;
      setAutofillTargetForm(newActiveForm);
      cachedAutofillData = null;
      cachedAutofillFieldsKey = null;
      if (newActiveForm) {
        const allElements = Array.from(
          newActiveForm.querySelectorAll("input, textarea, select"),
        );
        const processedRadioGroups = new Set<string>();

        activeFormFields = allElements
          .filter((el: Element) => {
            const input = el as HTMLInputElement;
            const type = input.type?.toLowerCase();
            if (type === "submit" || type === "button" || type === "hidden")
              return false;
            if (type === "radio") {
              const groupName = input.name;
              if (!groupName || processedRadioGroups.has(groupName))
                return false;
              processedRadioGroups.add(groupName);
              return true;
            }
            if (type === "checkbox") return !input.checked;
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
            const ariaLabel = input.getAttribute("aria-label")?.trim() || "";

            let options: string[] | undefined;
            if (input.tagName.toLowerCase() === "select") {
              options = Array.from((input as HTMLSelectElement).options)
                .filter((opt) => opt.value && opt.value !== "" && !opt.disabled)
                .map((opt) => opt.text.trim())
                .slice(0, 20);
            } else if (type === "radio" && (input as HTMLInputElement).name) {
              const radios = Array.from(
                newActiveForm.querySelectorAll<HTMLInputElement>(
                  `input[type="radio"][name="${(input as HTMLInputElement).name}"]`,
                ),
              );
              options = radios
                .filter((r) => r.value && !r.disabled)
                .map((r) => {
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
              labelText,
              ariaLabel,
              options,
            };
          });
      } else {
        activeFormFields = null;
      }
    }
  }
}

function handleMessage(
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) {
  switch (request.action) {
    case "TOGGLE_AGENT":
      setAgentState(request.enabled);
      break;
    case "SET_MISSION_PROMPT":
      currentMission = request.prompt || "";
      setMissionPrompt(currentMission);
      cachedAutofillData = null;
      cachedAutofillFieldsKey = null;
      break;
  }
  return true;
}

function buildPageContext(): PageContext {
  const visibleActions: ActionCandidate[] = [];

  // ── Clickable elements ───────────────────────────────────────────────────
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

  // ── Text / search input fields ───────────────────────────────────────────
  // These must be included so the AI can predict "type X into search box" actions.
  document
    .querySelectorAll(
      'input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input:not([type]), textarea',
    )
    .forEach((el) => {
      const element = el as HTMLInputElement | HTMLTextAreaElement;
      if (element.closest("[data-flow-recorder]")) return;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // Derive the most descriptive label available
      let label =
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("placeholder")?.trim() ||
        element.getAttribute("title")?.trim() ||
        "";
      if (!label && element.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (labelEl) label = labelEl.textContent?.trim() || "";
      }
      if (!label) {
        label = `${element.tagName.toLowerCase()} input`;
      }

      visibleActions.push({
        label,
        selector: generateCSSSelector(element),
        role: "secondary",
        boundingBox: rect,
        confidenceScore: 0.6,
        formSelector: element.closest("form")
          ? generateCSSSelector(element.closest("form")!)
          : undefined,
      });
    });
  return {
    pageIntent: inferPageIntent(
      window.location.href,
      [],
      visibleActions.slice(0, 50),
    ),
    visibleActions: visibleActions.slice(0, 50),
    forms: [],
    lastUserAction: null,
    lastActionRect: null,
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
    mission: currentMission || undefined,
  };
}

// --- Run ---
init();
