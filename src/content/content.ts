/**
 * Content script entry point.
 * Delegates to purpose-specific modules; only owns init, navigation, form-focus
 * tracking, and message handling.
 *
 * Module map:
 *   state.ts        — shared mutable state
 *   rateLimit.ts    — AI rate limiter + aiLog
 *   providers.ts    — getAIProvider()
 *   autofill.ts     — generateAutofillData, generateBasicFormData
 *   formDetect.ts   — detectFormForAgent, fillFormForAgent, checkAndShowFormBanner
 *   execution.ts    — findElementByLabel, executeAgentToolCall, executeForAgent, …
 *   prediction.ts   — buildPageElements, predictForAgent
 *   agentManager.ts — initializeAgent, setAgentState, getOrCreateAgentExecutor, …
 */

import { isAgentEnabled } from "@/utils/storage";
import { setMissionPrompt, setAutofillTargetForm } from "./agentPanel";
import { getGeminiCallStats, resetGeminiCallStats } from "@/utils/geminiProvider";
import type { FormFieldInfo } from "@/types/ai";
import { state } from "./state";
import { getRLState } from "./rateLimit";
import { initializeAgent, setAgentState, handleAgentStart, handleAgentContinue } from "./agentManager";
import { checkAndShowFormBanner } from "./formDetect";

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  if (window !== window.top) return;
  if ((window as any).__flowRecorderListenersAttached) return;
  (window as any).__flowRecorderListenersAttached = true;

  state.isAgentGloballyEnabled = await isAgentEnabled();

  try {
    const resp = await chrome.runtime.sendMessage({ action: "GET_MISSION_PROMPT" });
    if (resp?.prompt) state.currentMission = resp.prompt;
  } catch (_) { /* no-op */ }

  chrome.runtime.onMessage.addListener(handleMessage);
  document.addEventListener("focusin", captureFormFocus, true);
  patchHistoryForNavigation();

  if (state.isAgentGloballyEnabled) {
    initializeAgent();
    chrome.runtime
      .sendMessage({ action: "GET_AGENT_RUNNING" })
      .then(async (resp: { running?: boolean } | undefined) => {
        if (resp?.running && state.currentMission) {
          console.log("[Flow Agent] Resuming agent after navigation...");
          setTimeout(async () => {
            const continued = await handleAgentContinue();
            if (!continued) {
              console.log("[Flow Agent] No resume snapshot found — starting fresh.");
              handleAgentStart();
            }
          }, 800);
        }
      })
      .catch(() => {});
  }

  console.log("[Flow Agent] Initialized.");

  (window as any).__flowAgent = {
    geminiStats: () => getGeminiCallStats(),
    resetGeminiStats: () => { resetGeminiCallStats(); console.log("[FlowAgent] Gemini stats reset."); },
    rlState: () => getRLState(),
    agentActive: () => state.isAgentExecutorActive,
    agentSession: () => state.agentExecutor?.getSession() ?? null,
  };
  console.log("[FlowAgent] Debug helpers available via window.__flowAgent");
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function onPageNavigate(newUrl: string): void {
  if (newUrl === state.currentPageUrl) return;
  console.log(`[FlowAgent] Navigation detected: ${state.currentPageUrl} → ${newUrl}`);
  state.activeFormForAutofill = null;
  state.activeFormFields = null;
  state.currentPageUrl = newUrl;
  if (state.isAgentInitialized) setTimeout(checkAndShowFormBanner, 500);
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

// ─── Event capture ───────────────────────────────────────────────────────────

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

    if (newActiveForm !== state.activeFormForAutofill) {
      state.activeFormForAutofill = newActiveForm;
      setAutofillTargetForm(newActiveForm);
      state.cachedAutofillData = null;
      state.cachedAutofillFieldsKey = null;
      if (newActiveForm) {
        const allElements = Array.from(
          newActiveForm.querySelectorAll("input, textarea, select"),
        );
        const processedRadioGroups = new Set<string>();

        state.activeFormFields = allElements
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
        state.activeFormFields = null;
      }
    }
  }
}

function handleMessage(
  request: any,
  _sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: any) => void,
) {
  switch (request.action) {
    case "TOGGLE_AGENT":
      setAgentState(request.enabled);
      break;
    case "SET_MISSION_PROMPT":
      state.currentMission = request.prompt || "";
      setMissionPrompt(state.currentMission);
      state.cachedAutofillData = null;
      state.cachedAutofillFieldsKey = null;
      break;
  }
  return true;
}


// --- Run ---
init();
