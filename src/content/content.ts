/**
 * Content script entry point.
 * Delegates to purpose-specific modules; only owns init, navigation,
 * and message handling.
 *
 * Module map:
 *   state.ts        — shared mutable state
 *   rateLimit.ts    — AI rate limiter + aiLog
 *   providers.ts    — getAIProvider()
 *   execution.ts    — findElementByLabel, executeAgentToolCall, executeForAgent, …
 *   prediction.ts   — buildPageElements, predictForAgent
 *   agentManager.ts — initializeAgent, setAgentState, getOrCreateAgentExecutor, …
 */

import { isAgentEnabled } from "@/utils/storage";
import { setMissionPrompt } from "./agent/agentPanel";
import {
  getGeminiCallStats,
  resetGeminiCallStats,
} from "@/utils/geminiProvider";
import { state } from "./state";
import { getRLState } from "./ai/rateLimit";
import {
  initializeAgent,
  setAgentState,
  handleAgentStart,
  handleAgentContinue,
} from "./agent/agentManager";

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  if (window !== window.top) return;
  if ((window as any).__flowRecorderListenersAttached) return;
  (window as any).__flowRecorderListenersAttached = true;

  state.isAgentGloballyEnabled = await isAgentEnabled();

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "GET_MISSION_PROMPT",
    });
    if (resp?.prompt) state.currentMission = resp.prompt;
  } catch (_) {
    /* no-op */
  }

  chrome.runtime.onMessage.addListener(handleMessage);
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
              console.log(
                "[Flow Agent] No resume snapshot found — starting fresh.",
              );
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
    resetGeminiStats: () => {
      resetGeminiCallStats();
      console.log("[FlowAgent] Gemini stats reset.");
    },
    rlState: () => getRLState(),
    agentActive: () => state.isAgentExecutorActive,
    agentSession: () => state.agentExecutor?.getSession() ?? null,
  };
  console.log("[FlowAgent] Debug helpers available via window.__flowAgent");
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function onPageNavigate(newUrl: string): void {
  if (newUrl === state.currentPageUrl) return;
  console.log(
    `[FlowAgent] Navigation detected: ${state.currentPageUrl} → ${newUrl}`,
  );
  state.currentPageUrl = newUrl;
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

  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ) {
    originalReplaceState(...args);
    onPageNavigate(window.location.href);
  };

  window.addEventListener("popstate", () => {
    onPageNavigate(window.location.href);
  });

  console.log("[FlowAgent] Navigation listener attached.");
}

// ─── Event capture ───────────────────────────────────────────────────────────

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
      break;
  }
  return true;
}

// --- Run ---
init();
