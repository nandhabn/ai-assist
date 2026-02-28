import React from "react";
import "./App.css";
import RecorderControl from "./components/RecorderControl";
import FlowViewer from "./components/FlowViewer";
import AIPanel from "./components/AIPanel";
import Dashboard from "./components/Dashboard";

export default function App() {
  const [view, setView] = React.useState("dashboard"); // dashboard, control, flow, ai
  const [isRecording, setIsRecording] = React.useState(false);
  const [isAgentEnabled, setIsAgentEnabled] = React.useState(true);
  const [isChatGPTTab, setIsChatGPTTab] = React.useState(false);
  const [eventCount, setEventCount] = React.useState(0);

  const isTabView =
    new URLSearchParams(window.location.search).get("view") === "tab";

  React.useEffect(() => {
    // Check initial status
    chrome.storage.local.get(
      ["flowRecorder_events", "flowRecorder_isRecording"],
      (data) => {
        setEventCount(data.flowRecorder_events?.length || 0);
        setIsRecording(data.flowRecorder_isRecording || false);
      },
    );

    // Load per-tab agent-enabled state from background
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) {
        chrome.runtime.sendMessage(
          { action: "GET_AGENT_ENABLED", tabId },
          (resp) => {
            setIsAgentEnabled(resp?.enabled !== false);
            setIsChatGPTTab(resp?.chatgptTab === true);
          },
        );
      }
    });

    // Check event count
    chrome.runtime.sendMessage({ action: "GET_EVENTS" }, (response) => {
      setEventCount(response.events?.length || 0);
    });

    // Listen for recording/event updates
    const handleStorageChange = (changes) => {
      if (changes.flowRecorder_events) {
        const events = changes.flowRecorder_events.newValue || [];
        setEventCount(events.length);
      }
      if (changes.flowRecorder_isRecording) {
        setIsRecording(changes.flowRecorder_isRecording.newValue);
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  const handleViewChange = (newView) => {
    setView(newView);
  };

  const openInNewTab = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
  };

  const handleToggleAgent = () => {
    if (isChatGPTTab) return; // agent is always off on ChatGPT tabs
    const newStatus = !isAgentEnabled;
    setIsAgentEnabled(newStatus);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) {
        chrome.runtime.sendMessage(
          { action: "SET_AGENT_ENABLED", tabId, enabled: newStatus },
          (resp) => {
            if (!resp?.ok) {
              setIsAgentEnabled(!newStatus); // revert on failure
            }
          },
        );
      }
    });
  };

  return (
    <div className={`app ${isTabView ? "tab-view" : ""}`}>
      <header className="header">
        <div className="header-row">
          <h1>🔴 Flow Recorder</h1>
          <div className="header-actions">
            {!isTabView && (
              <button
                className="open-in-tab-btn"
                onClick={openInNewTab}
                title="Open in a new tab"
              >
                ↗️
              </button>
            )}
            <div className="status">
              {isRecording && (
                <span className="recording-badge">Recording...</span>
              )}
              <span className="event-count">{eventCount} events</span>
            </div>
          </div>
        </div>
        <div className="header-agent-row">
          <span className="header-agent-label">
            AI Prediction Assistant
            {isChatGPTTab && (
              <span
                className="header-agent-note"
                title="Agent is disabled on ChatGPT tabs — the bridge handles prompt injection here"
              >
                {" "}
                (bridge only)
              </span>
            )}
          </span>
          <label
            className={`header-agent-toggle${
              isChatGPTTab ? " header-agent-toggle--disabled" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={isAgentEnabled}
              onChange={handleToggleAgent}
              disabled={isChatGPTTab}
            />
            <span className="header-agent-slider"></span>
          </label>
        </div>
      </header>

      <nav className="nav">
        <button
          className={`nav-btn ${view === "dashboard" ? "active" : ""}`}
          onClick={() => handleViewChange("dashboard")}
        >
          📊 Dashboard
        </button>
        <button
          className={`nav-btn ${view === "control" ? "active" : ""}`}
          onClick={() => handleViewChange("control")}
        >
          ⚙️ Control
        </button>
        <button
          className={`nav-btn ${view === "flow" ? "active" : ""}`}
          onClick={() => handleViewChange("flow")}
        >
          📋 Flow
        </button>
        <button
          className={`nav-btn ${view === "ai" ? "active" : ""}`}
          onClick={() => handleViewChange("ai")}
        >
          🤖 AI
        </button>
      </nav>

      <main className="main">
        {view === "dashboard" && (
          <Dashboard
            eventCount={eventCount}
            isRecording={isRecording}
            isAgentEnabled={isAgentEnabled}
          />
        )}
        {view === "control" && (
          <RecorderControl
            onRecordingChange={setIsRecording}
            isAgentEnabled={isAgentEnabled}
            onToggleAgent={handleToggleAgent}
            isChatGPTTab={isChatGPTTab}
          />
        )}
        {view === "flow" && <FlowViewer eventCount={eventCount} />}
        {view === "ai" && <AIPanel />}
      </main>

      <footer className="footer">
        <small>v1.0.0 | AI Flow Recorder</small>
      </footer>
    </div>
  );
}
