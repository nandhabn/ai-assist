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
  const [eventCount, setEventCount] = React.useState(0);

  const isTabView =
    new URLSearchParams(window.location.search).get("view") === "tab";

  React.useEffect(() => {
    // Check initial status
    chrome.storage.local.get(
      [
        "flowRecorder_events",
        "flowRecorder_isRecording",
        "flowRecorder_agentEnabled",
      ],
      (data) => {
        setEventCount(data.flowRecorder_events?.length || 0);
        setIsRecording(data.flowRecorder_isRecording || false);
        setIsAgentEnabled(data.flowRecorder_agentEnabled !== false);
      },
    );

    // Check recording status
    chrome.runtime.sendMessage({ action: "GET_EVENTS" }, (response) => {
      setEventCount(response.events?.length || 0);
    });

    // Listen for updates
    const handleStorageChange = (changes) => {
      if (changes.flowRecorder_events) {
        const events = changes.flowRecorder_events.newValue || [];
        setEventCount(events.length);
      }

      if (changes.flowRecorder_isRecording) {
        setIsRecording(changes.flowRecorder_isRecording.newValue);
      }

      if (changes.flowRecorder_agentEnabled) {
        setIsAgentEnabled(changes.flowRecorder_agentEnabled.newValue !== false);
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

  const handleToggleAgent = async () => {
    const newStatus = !isAgentEnabled;
    setIsAgentEnabled(newStatus);
    try {
      await chrome.storage.local.set({ flowRecorder_agentEnabled: newStatus });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: "TOGGLE_AGENT",
            enabled: newStatus,
          });
        }
      });
    } catch (error) {
      console.error("Failed to toggle agent:", error);
      setIsAgentEnabled(!newStatus);
    }
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
          <span className="header-agent-label">AI Prediction Assistant</span>
          <label className="header-agent-toggle">
            <input
              type="checkbox"
              checked={isAgentEnabled}
              onChange={handleToggleAgent}
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
          <RecorderControl onRecordingChange={setIsRecording} />
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
