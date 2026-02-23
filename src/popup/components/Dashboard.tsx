import React from "react";
import "../styles/Dashboard.css";

interface DashboardProps {
  eventCount: number;
  isRecording: boolean;
  isAgentEnabled: boolean;
}

interface FlowEvent {
  actionType: "click" | "input" | "submit" | "api_call" | "route_change";
  timestamp: number;
  url: string;
}

export default function Dashboard({
  eventCount,
  isRecording,
  isAgentEnabled,
}: DashboardProps) {
  const [events, setEvents] = React.useState<FlowEvent[]>([]);
  const [stats, setStats] = React.useState({
    clicks: 0,
    inputs: 0,
    submits: 0,
    apiCalls: 0,
    routeChanges: 0,
    uniquePages: 0,
  });

  React.useEffect(() => {
    loadStats();

    const handleStorageChange = (changes: {
      [key: string]: chrome.storage.StorageChange;
    }) => {
      if (changes.flowRecorder_events) {
        loadStats();
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [eventCount]);

  const loadStats = async () => {
    try {
      const response = await new Promise<{ events: FlowEvent[] }>((resolve) => {
        chrome.runtime.sendMessage({ action: "GET_EVENTS" }, resolve);
      });
      const loadedEvents = response.events || [];
      setEvents(loadedEvents);

      // Calculate stats
      const newStats = {
        clicks: loadedEvents.filter((e) => e.actionType === "click").length,
        inputs: loadedEvents.filter((e) => e.actionType === "input").length,
        submits: loadedEvents.filter((e) => e.actionType === "submit").length,
        apiCalls: loadedEvents.filter((e) => e.actionType === "api_call")
          .length,
        routeChanges: loadedEvents.filter(
          (e) => e.actionType === "route_change",
        ).length,
        uniquePages: new Set(loadedEvents.map((e) => e.url)).size,
      };
      setStats(newStats);
    } catch (error) {
      console.error("Failed to load stats:", error);
    }
  };

  const handleQuickAction = (action: string) => {
    switch (action) {
      case "export":
        const dataStr = JSON.stringify(events, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flow_export_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        break;
      case "clear":
        if (window.confirm("Clear all recorded events?")) {
          chrome.runtime.sendMessage({ action: "CLEAR_EVENTS" });
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Overview</h2>
        <div className="status-badges">
          {isRecording && (
            <span className="status-badge recording">🔴 Recording</span>
          )}
          {isAgentEnabled && (
            <span className="status-badge agent">🤖 Agent Active</span>
          )}
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card primary">
          <div className="stat-icon">📊</div>
          <div className="stat-content">
            <div className="stat-value">{eventCount}</div>
            <div className="stat-label">Total Events</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">🖱</div>
          <div className="stat-content">
            <div className="stat-value">{stats.clicks}</div>
            <div className="stat-label">Clicks</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">⌨️</div>
          <div className="stat-content">
            <div className="stat-value">{stats.inputs}</div>
            <div className="stat-label">Inputs</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">🌐</div>
          <div className="stat-content">
            <div className="stat-value">{stats.apiCalls}</div>
            <div className="stat-label">API Calls</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">📍</div>
          <div className="stat-content">
            <div className="stat-value">{stats.uniquePages}</div>
            <div className="stat-label">Pages</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-content">
            <div className="stat-value">{stats.submits}</div>
            <div className="stat-label">Submits</div>
          </div>
        </div>
      </div>

      <div className="quick-actions">
        <h3>Quick Actions</h3>
        <div className="actions-grid">
          <button
            className="action-btn"
            onClick={() => handleQuickAction("export")}
            disabled={eventCount === 0}
          >
            <span className="action-icon">📥</span>
            <span className="action-label">Export JSON</span>
          </button>
          <button
            className="action-btn"
            onClick={() => handleQuickAction("clear")}
            disabled={eventCount === 0 || isRecording}
          >
            <span className="action-icon">🗑️</span>
            <span className="action-label">Clear Events</span>
          </button>
        </div>
      </div>

      {eventCount === 0 && (
        <div className="empty-dashboard">
          <div className="empty-icon">📝</div>
          <p>No events recorded yet</p>
          <small>Start recording to see your flow statistics here</small>
        </div>
      )}
    </div>
  );
}
