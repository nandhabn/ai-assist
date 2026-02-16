import {
  setRecordingStatus,
  getOrCreateSessionId,
  saveSession,
  getEvents,
  clearEvents,
} from "@/utils/storage";
import { prepareFlowForAI } from "@/utils/aiFormatter";

// Initialize background service worker
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[FlowRecorder] Extension installed");
  const sessionId = await getOrCreateSessionId();
  console.log("[FlowRecorder] Session initialized:", sessionId);
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
        case "PREPARE_FOR_AI": {
          const sessionId = await getOrCreateSessionId();
          const events = await getEvents();
          const flowData = { sessionId, events };
          const aiResult = prepareFlowForAI(flowData);
          sendResponse(aiResult);
          break;
        }
        case "EVENT_RECORDED": {
          sendResponse({ acknowledged: true });
          break;
        }
        default:
          sendResponse({ error: "Unknown action" });
      }
    } catch (error: any) {
      console.error("[FlowRecorder] Error:", error);
      sendResponse({ error: error.message });
    }
  })();
  // Return true to keep connection open for async operations
  return true;
});
