import {
  setRecordingStatus,
  getOrCreateSessionId,
  saveSession,
  getEvents,
  clearEvents,
} from "@/utils/storage";
import { prepareFlowData } from "@/utils/aiFormatter";

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
