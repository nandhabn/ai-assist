/**
 * Agent lifecycle management.
 * Owns: initializeAgent, decommissionAgent, setAgentState, getOrCreateAgentExecutor,
 * saveAgentSession, and start/stop/pause/resume handlers.
 */

import {
  AgentExecutor,
  AgentStatus,
  AgentStep,
  AgentSession,
  AgentResumeSnapshot,
} from "@/utils/agentExecutor";
import { isAgentEnabled, setAgentEnabled } from "@/utils/storage";
import {
  initAgentPanel,
  toggleAgentPanelVisibility,
  setMissionPrompt,
  updateAgentControlUI,
  appendAgentLogEntry,
  clearAgentLog,
  flashAutoExecution,
} from "./agentPanel";
import { state } from "../state";
import { getAIProvider } from "../ai/providers";
import { predictForAgent, consumeLastPredictionContext } from "./prediction";
import { executeForAgent } from "./execution";
import { loadAndSyncSkills } from "./tools";

// ─── Snapshot persistence (cross-navigation resume) ─────────────────────────

const RESUME_SNAPSHOT_KEY = "agentResumeSnapshot";

export async function saveAgentResumeSnapshot(): Promise<void> {
  if (!state.agentExecutor) return;
  const snapshot = state.agentExecutor.getResumeSnapshot();
  if (!snapshot) return;
  try {
    await chrome.storage.local.set({ [RESUME_SNAPSHOT_KEY]: snapshot });
  } catch (e) {
    console.warn("[Agent] Failed to save resume snapshot:", e);
  }
}

export async function clearAgentResumeSnapshot(): Promise<void> {
  try {
    await chrome.storage.local.remove(RESUME_SNAPSHOT_KEY);
  } catch (_) {
    /* no-op */
  }
}

/**
 * Called on a freshly-loaded page. If a resume snapshot exists (written before
 * the previous page navigated away) the executor will restore its state and
 * continue the mission loop — no reset, no re-planning.
 * Returns true if a snapshot was found and resumed.
 */
export async function handleAgentContinue(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get(RESUME_SNAPSHOT_KEY);
    const snapshot = data[RESUME_SNAPSHOT_KEY] as
      | AgentResumeSnapshot
      | undefined;
    if (!snapshot?.session) return false;

    // Don't restore stale sessions (older than 1 hour)
    if (Date.now() - snapshot.session.startTime > 60 * 60 * 1000) {
      await clearAgentResumeSnapshot();
      return false;
    }

    // Sync mission to state so UI stays consistent
    if (snapshot.session.mission && !state.currentMission) {
      state.currentMission = snapshot.session.mission;
    }

    const executor = getOrCreateAgentExecutor();
    clearAgentLog();
    // Re-render previously completed steps in the log
    snapshot.session.steps.forEach((step) => appendAgentLogEntry(step));
    console.log(
      `[Flow Agent] Continuing session "${snapshot.session.id}" from step ${snapshot.stepCount} on new page.`,
    );
    executor.continueFrom(snapshot);
    return true;
  } catch (e) {
    console.warn("[Agent] Failed to restore resume snapshot:", e);
    return false;
  }
}

// ─── Panel init ───────────────────────────────────────────────────────────────

export function initializeAgent(): void {
  if (state.isAgentInitialized) return;

  console.log("[Flow Agent] Initializing...");
  initAgentPanel(
    () => {
      /* manual prediction execution not used in tool-call mode */
    },
    () => {
      /* no prediction refresh — agent drives its own loop */
    },
    {
      onStart: handleAgentStart,
      onStop: handleAgentStop,
      onPause: handleAgentPause,
      onResume: handleAgentResume,
    },
  );
  toggleAgentPanelVisibility(true);

  // Seed the tool registry with skill tools already in storage
  loadAndSyncSkills().catch(() => {/* no-op if storage unavailable */});

  // Re-sync skill tools whenever skills are added/edited/toggled in the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "flowRecorder_agentSkills" in changes) {
      loadAndSyncSkills().catch(() => {/* no-op */});
    }
  });

  state.isAgentInitialized = true;
}

export function decommissionAgent(): void {
  if (!state.isAgentInitialized) return;
  console.log("[Flow Agent] Decommissioning...");
  toggleAgentPanelVisibility(false);
  state.isAgentInitialized = false;
}

export async function setAgentState(enabled: boolean): Promise<void> {
  if (enabled === state.isAgentGloballyEnabled) return;
  state.isAgentGloballyEnabled = enabled;
  await setAgentEnabled(enabled);
  if (enabled) initializeAgent();
  else decommissionAgent();
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export function getOrCreateAgentExecutor(): AgentExecutor {
  if (!state.agentExecutor) {
    state.agentExecutor = new AgentExecutor(
      {
        predict: predictForAgent,
        execute: executeForAgent,
        getLastActionFailure: () => {
          const v = state.lastActionFailure;
          state.lastActionFailure = null;
          return v;
        },
        setLastActionFailure: (msg: string | null) => {
          state.lastActionFailure = msg;
        },
        onSessionSave: (session: AgentSession) => {
          saveAgentSession(session);
        },
        onStatusChange: (
          status: AgentStatus,
          stepCount: number,
          message?: string,
        ) => {
          state.isAgentExecutorActive =
            status === "running" || status === "paused";

          // Clear snapshot once the session reaches a terminal state so it
          // doesn't accidentally resume a finished/stopped session later.
          if (
            status === "completed" ||
            status === "stopped" ||
            status === "error"
          ) {
            clearAgentResumeSnapshot();
          }

          const flyout = document.getElementById("flow-recorder-flyout");
          if (flyout)
            flyout.style.display = state.isAgentExecutorActive ? "none" : "";

          updateAgentControlUI(status, stepCount, message);
          console.log(
            `[Agent] Status: ${status} | Steps: ${stepCount}${message ? ` | ${message}` : ""}`,
          );

          chrome.runtime
            .sendMessage({
              action: "SET_AGENT_RUNNING",
              running: state.isAgentExecutorActive,
            })
            .catch(() => {});
        },
        onStepComplete: (step: AgentStep) => {
          // Attach the prompt sent to the AI before rendering so the tooltip can show it
          const predCtx = consumeLastPredictionContext();
          if (predCtx?.prompt) step.prompt = predCtx.prompt;
          // Update the plan step counter from what the AI reported (independent of tool-call count)
          if (predCtx?.toolCall.planStep != null) {
            state.agentExecutor?.setPlanStep(predCtx.toolCall.planStep);
          }
          appendAgentLogEntry(step);
          flashAutoExecution();
          // Build and record the full turn (page state + AI decision + outcome)
          if (predCtx && state.agentExecutor) {
            state.agentExecutor.addTurn({
              stepNumber: step.stepNumber,
              pageUrl: predCtx.pageUrl,
              pageTitle: predCtx.pageTitle,
              elementsSnapshot: predCtx.pageElements,
              toolCall: predCtx.toolCall,
              observation: predCtx.observation,
              success: step.success,
              timestamp: step.timestamp,
            });
          }
          // Persist snapshot so the session survives a full-page navigation
          saveAgentResumeSnapshot();
        },
      },
    );
  }
  return state.agentExecutor;
}

// ─── Control handlers ─────────────────────────────────────────────────────────

export function handleAgentStart(): void {
  if (!state.currentMission) {
    console.warn(
      "[Agent] Cannot start without a mission. Set a mission prompt first.",
    );
    updateAgentControlUI("error", 0, "Set a mission first");
    return;
  }
  const executor = getOrCreateAgentExecutor();
  clearAgentLog();
  executor.start(state.currentMission);
}

export function handleAgentStop(): void {
  state.agentExecutor?.stop();
}

export function handleAgentPause(): void {
  state.agentExecutor?.pause();
}

export function handleAgentResume(): void {
  state.agentExecutor?.resume();
}

// ─── Session persistence ──────────────────────────────────────────────────────

/** Persists an agent session to chrome.storage.local (keeps last 20). */
export async function saveAgentSession(session: AgentSession): Promise<void> {
  try {
    const key = session.id;
    const indexData = await chrome.storage.local.get("agentSessionIndex");
    const index: string[] = (indexData["agentSessionIndex"] as string[]) || [];
    if (!index.includes(key)) {
      index.push(key);
      if (index.length > 20) index.splice(0, index.length - 20);
    }
    await chrome.storage.local.set({
      [key]: session,
      agentSessionIndex: index,
    });
    console.log(`[Agent] Session saved: ${key} (${session.status})`);
  } catch (e) {
    console.warn("[Agent] Failed to save session:", e);
  }
}

// ─── Init helper (re-exported for content.ts) ─────────────────────────────────

/**
 * Reads the enabled flag from storage and returns it.
 * Convenience re-export so content.ts can use it without extra imports.
 */
export { isAgentEnabled };
