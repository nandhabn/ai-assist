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

// ---- ChatGPT tab detection ----
function isChatGPTUrl(url: string | undefined): boolean {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/$|$|\/)/i.test(
    url || "",
  );
}
// ---- end ChatGPT detection ----

// ---- Per-tab agent-enabled helpers ----
function agentEnabledKey(tabId: number) {
  return `flowRecorder_agentEnabled_${tabId}`;
}
async function getTabAgentEnabled(tabId: number): Promise<boolean> {
  const data = await chrome.storage.local.get(agentEnabledKey(tabId));
  // Default to true when not explicitly disabled
  return data[agentEnabledKey(tabId)] !== false;
}
async function setTabAgentEnabled(tabId: number, enabled: boolean) {
  if (enabled) {
    await chrome.storage.local.remove(agentEnabledKey(tabId));
  } else {
    await chrome.storage.local.set({ [agentEnabledKey(tabId)]: false });
  }
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
          // Agent is always disabled on ChatGPT tabs (the bridge handles those).
          const tabId = (request.tabId as number | undefined) ?? sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ enabled: true });
            break;
          }
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (isChatGPTUrl(tab?.url)) {
            sendResponse({ enabled: false, chatgptTab: true });
            break;
          }
          const enabled = await getTabAgentEnabled(tabId);
          sendResponse({ enabled });
          break;
        }
        case "SET_AGENT_ENABLED": {
          // Store the per-tab agent state and relay TOGGLE_AGENT to that tab's content script.
          // Silently ignore requests to enable the agent on ChatGPT tabs.
          const tabId = (request.tabId as number | undefined) ?? sender.tab?.id;
          if (tabId === undefined) {
            sendResponse({ ok: false, error: "No tab ID" });
            break;
          }
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (isChatGPTUrl(tab?.url)) {
            sendResponse({ ok: true, chatgptTab: true });
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
        case "CHATGPT_TAB_PROXY": {
          // Relay prompt to the ChatGPT bridge tab — ACK immediately so channel doesn't time out.
          // The bridge will call back via CHATGPT_BRIDGE_RESULT when done.
          const chatgptTabs = await chrome.tabs.query({
            url: "https://chatgpt.com/*",
          });
          const legacyTabs = await chrome.tabs.query({
            url: "https://chat.openai.com/*",
          });
          const allTabs = [...chatgptTabs, ...legacyTabs];

          if (allTabs.length === 0) {
            sendResponse({
              queued: false,
              error: "No ChatGPT tab found. Please open chatgpt.com in a tab.",
            });
            break;
          }

          const targetTab = allTabs[0];
          if (!targetTab.id) {
            sendResponse({ queued: false, error: "ChatGPT tab has no ID" });
            break;
          }

          // Fire-and-forget relay — do NOT await
          chrome.tabs
            .sendMessage(targetTab.id, {
              action: "CHATGPT_BRIDGE_REQUEST",
              prompt: request.prompt,
              requestId: request.requestId,
            })
            .catch((err) =>
              console.error("[FlowRecorder] Bridge relay error:", err),
            );

          console.log(
            `[FlowRecorder] Queued to ChatGPT tab ${targetTab.id}, requestId: ${request.requestId}`,
          );
          sendResponse({ queued: true });
          break;
        }
        case "CHATGPT_BRIDGE_RESULT": {
          // Bridge finished — store result in session storage for polling content script
          const storageKey = `__chatgpt_bridge_${request.requestId}`;
          await chrome.storage.session.set({
            [storageKey]: {
              success: request.success,
              response: request.response,
              error: request.error,
            },
          });
          console.log(
            `[FlowRecorder] Bridge result stored for ${request.requestId}, success: ${request.success}`,
          );
          sendResponse({ ok: true });
          break;
        }
        case "CHATGPT_BRIDGE_POLL": {
          // Content scripts can't access chrome.storage.session — proxy the poll through here
          const storageKey = `__chatgpt_bridge_${request.requestId}`;
          const stored = await chrome.storage.session.get(storageKey);
          const result = stored[storageKey] ?? null;
          if (result) {
            await chrome.storage.session.remove(storageKey);
          }
          sendResponse({ result });
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
