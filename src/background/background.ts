import {
  setRecordingStatus,
  getOrCreateSessionId,
  saveSession,
  getEvents,
  clearEvents,
} from "@/utils/storage";
import { prepareFlowData } from "@/utils/aiFormatter";

// ---- Per-tab mission prompt helpers ----
function missionKey(tabId: number) {
  return `flowRecorder_missionPrompt_${tabId}`;
}
async function getMission(tabId: number): Promise<string> {
  const data = await chrome.storage.local.get(missionKey(tabId));
  return data[missionKey(tabId)] || "";
}
async function setMission(tabId: number, prompt: string) {
  if (prompt) {
    await chrome.storage.local.set({ [missionKey(tabId)]: prompt });
  } else {
    await chrome.storage.local.remove(missionKey(tabId));
  }
}
// ---- end helpers ----

// ---- Per-tab agent-enabled helpers ----
function agentEnabledKey(tabId: number) {
  return `flowRecorder_agentEnabled_${tabId}`;
}
async function getTabAgentEnabled(tabId: number): Promise<boolean> {
  const data = await chrome.storage.local.get(agentEnabledKey(tabId));
  // Default to false when not explicitly enabled
  return data[agentEnabledKey(tabId)] === true;
}
async function setTabAgentEnabled(tabId: number, enabled: boolean) {
  await chrome.storage.local.set({ [agentEnabledKey(tabId)]: enabled });
}
// ---- end agent helpers ----

// ---- Per-tab agent-running state (for cross-navigation resumption) ----
const agentRunningTabs = new Map<number, boolean>();

function isAgentRunningForTab(tabId: number): boolean {
  return agentRunningTabs.get(tabId) === true;
}

function setAgentRunningForTab(tabId: number, running: boolean) {
  if (running) {
    agentRunningTabs.set(tabId, true);
  } else {
    agentRunningTabs.delete(tabId);
  }
}
// ---- end agent-running helpers ----

// Initialize background service worker
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[FlowRecorder] Extension installed");
  const sessionId = await getOrCreateSessionId();
  console.log("[FlowRecorder] Session initialized:", sessionId);
});

// When a new tab is opened, inherit the opener tab's mission prompt
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined || !tab.openerTabId) return;
  const parentMission = await getMission(tab.openerTabId);
  if (parentMission) {
    await setMission(tab.id, parentMission);
    // Deliver it once the tab's content script is ready (retry up to 3s)
    const deliver = (attempt = 0) => {
      chrome.tabs
        .sendMessage(tab.id!, {
          action: "SET_MISSION_PROMPT",
          prompt: parentMission,
        })
        .catch(() => {
          if (attempt < 6) setTimeout(() => deliver(attempt + 1), 500);
        });
    };
    setTimeout(() => deliver(), 800);
  }
});

// Clean up per-tab storage when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(missionKey(tabId)).catch(() => {});
  chrome.storage.local.remove(agentEnabledKey(tabId)).catch(() => {});
  agentRunningTabs.delete(tabId);
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {
        case "START_RECORDING": {
          await setRecordingStatus(true);
          const tabs = await chrome.tabs.query({});
          tabs.forEach((tab) => {
            if (tab.id !== undefined) {
              chrome.tabs
                .sendMessage(tab.id, { action: "START_RECORDING" })
                .catch(() => {});
            }
          });
          sendResponse({ success: true });
          break;
        }
        case "STOP_RECORDING": {
          await setRecordingStatus(false);
          const tabs = await chrome.tabs.query({});
          tabs.forEach((tab) => {
            if (tab.id !== undefined) {
              chrome.tabs
                .sendMessage(tab.id, { action: "STOP_RECORDING" })
                .catch(() => {});
            }
          });
          sendResponse({ success: true });
          break;
        }
        case "GET_EVENTS": {
          const events = await getEvents();
          sendResponse({ events });
          break;
        }
        case "CLEAR_EVENTS": {
          await clearEvents();
          sendResponse({ success: true });
          break;
        }
        case "GET_SESSION_ID": {
          const sessionId = await getOrCreateSessionId();
          sendResponse({ sessionId });
          break;
        }
        case "SAVE_SESSION": {
          const sessionId = await getOrCreateSessionId();
          const events = await getEvents();
          const flowData = { sessionId, events, ...request.flowData };
          await saveSession(flowData);
          await clearEvents();
          sendResponse({ success: true });
          break;
        }
        case "GENERATE_AI_SCRIPT": {
          const sessionId = await getOrCreateSessionId();
          const events = await getEvents();
          const flowDataPackage = prepareFlowData({ sessionId, events });

          if (!flowDataPackage) {
            sendResponse({
              success: false,
              error: "No data to process for AI script generation.",
            });
            return;
          }

          // TODO: Replace with the actual backend proxy endpoint from environment configuration
          const BACKEND_PROXY_URL =
            "https://your-secure-backend.com/api/generate-script";

          try {
            /*
            // This is the future implementation for when the backend proxy is ready.
            console.log('[FlowRecorder] Sending data to backend proxy:', BACKEND_PROXY_URL);
            const response = await fetch(BACKEND_PROXY_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(flowDataPackage),
            });

            if (!response.ok) {
              const errorBody = await response.text();
              throw new Error(`Backend request failed: ${response.status} ${response.statusText} - ${errorBody}`);
            }

            const aiResult = await response.json();
            sendResponse({ success: true, data: aiResult });
            */

            // For now, during transition, return a mocked successful response.
            // This allows the frontend to be developed without a live backend.
            console.log("[FlowRecorder] Using mocked AI response for now.");
            const mockAiResult = {
              summary: flowDataPackage.summary,
              structuredPrompt:
                "// AI-generated script will appear here once the backend proxy is connected.\n\n// Mocked response:\nconsole.log('Flow Recorder test script generated!');",
              metadata: flowDataPackage.metadata,
            };

            // Simulate network delay
            setTimeout(() => {
              sendResponse({ success: true, data: mockAiResult });
            }, 1000);
          } catch (error: any) {
            console.error("[FlowRecorder] Backend proxy error:", error);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }
        case "EVENT_RECORDED": {
          // This message is primarily to keep the service worker alive during recording.
          // No data processing needed, just acknowledge receipt.
          sendResponse({ acknowledged: true });
          break;
        }
        case "SET_MISSION_PROMPT": {
          // Store the mission scoped to the sending tab only.
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: "No tab ID" });
            break;
          }
          await setMission(tabId, request.prompt || "");
          // Deliver back to the same tab so content.ts can update its variable
          chrome.tabs
            .sendMessage(tabId, {
              action: "SET_MISSION_PROMPT",
              prompt: request.prompt || "",
            })
            .catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "GET_MISSION_PROMPT": {
          // Return the mission for the requesting tab.
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ prompt: "" });
            break;
          }
          const prompt = await getMission(tabId);
          sendResponse({ prompt });
          break;
        }
        case "GET_AGENT_ENABLED": {
          // Return the agent-enabled state for the requesting/specified tab.
          const tabId = (request.tabId as number | undefined) ?? sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ enabled: false });
            break;
          }
          const enabled = await getTabAgentEnabled(tabId);
          sendResponse({ enabled });
          break;
        }
        case "SET_AGENT_ENABLED": {
          // Store the per-tab agent state and relay TOGGLE_AGENT to that tab's content script.
          const tabId = (request.tabId as number | undefined) ?? sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: "No tab ID" });
            break;
          }
          await setTabAgentEnabled(tabId, request.enabled);
          chrome.tabs
            .sendMessage(tabId, {
              action: "TOGGLE_AGENT",
              enabled: request.enabled,
            })
            .catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case "SET_AGENT_RUNNING": {
          const tabId = sender.tab?.id;
          if (tabId !== undefined) {
            setAgentRunningForTab(tabId, request.running);
          }
          sendResponse({ ok: true });
          break;
        }
        case "GET_AGENT_RUNNING": {
          const tabId = sender.tab?.id;
          sendResponse({
            running: tabId !== undefined ? isAgentRunningForTab(tabId) : false,
          });
          break;
        }
        default:
          sendResponse({ error: "Unknown action" });
      }
    } catch (error: any) {
      console.error("[FlowRecorder] Error in background script:", error);
      sendResponse({ error: error.message });
    }
  })();
  // Return true to keep the message channel open for asynchronous responses
  return true;
});
