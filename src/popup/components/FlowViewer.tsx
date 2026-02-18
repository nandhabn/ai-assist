import React from "react";
import "../styles/FlowViewer.css";

interface FlowEvent {
  actionType: "click" | "input" | "submit" | "api_call" | "route_change";
  sessionId: string;
  elementMetadata?: {
    tag?: string;
    id?: string;
    className?: string;
    innerText?: string;
    ariaLabel?: string;
  };
  apiDetails?: {
    method?: string;
    endpoint?: string;
    status?: number;
    duration?: number;
  };
  route?: string;
  timestamp: number;
  url: string;
  selector?: {
    css?: string;
    xpath?: string;
  };
}

interface FlowViewerProps {
  eventCount: number;
}

export default function FlowViewer({ eventCount }: FlowViewerProps) {
  const [allEvents, setAllEvents] = React.useState<FlowEvent[]>([]);
  const [sessions, setSessions] = React.useState<Record<string, FlowEvent[]>>(
    {},
  );
  const [loading, setLoading] = React.useState(false);
  const [expandedEvent, setExpandedEvent] = React.useState<string | null>(null); // sessionId_index
  const [replayingSession, setReplayingSession] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    loadEvents();
  }, [eventCount]);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const response = await new Promise<{ events: FlowEvent[] }>((resolve) => {
        chrome.runtime.sendMessage({ action: "GET_EVENTS" }, resolve);
      });
      const events = response.events || [];
      setAllEvents(events);

      const grouped = events.reduce(
        (acc, event) => {
          const sid = event.sessionId || "unknown";
          if (!acc[sid]) {
            acc[sid] = [];
          }
          acc[sid].push(event);
          return acc;
        },
        {} as Record<string, FlowEvent[]>,
      );
      setSessions(grouped);
    } catch (error) {
      console.error("Failed to load events:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    const dataStr = JSON.stringify(allEvents, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flow_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRedo = (event: FlowEvent) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: "REDO_ACTION", event },
          (response) => {
            if (chrome.runtime.lastError) {
              alert(
                `Failed to replay action: ${chrome.runtime.lastError.message}`,
              );
              return;
            }
            if (response?.success) {
              alert("Action replayed successfully!");
            } else {
              alert(
                `Failed to replay action: ${response?.error || "Unknown error"}`,
              );
            }
          },
        );
      } else {
        alert("Could not find active tab to replay action on.");
      }
    });
  };

  const handleReplaySession = async (sessionId: string) => {
    const sessionEvents = sessions[sessionId];
    if (!sessionEvents || sessionEvents.length === 0) {
      alert("No events to replay in this session.");
      return;
    }

    setReplayingSession(sessionId);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        const tabId = tabs[0].id;

        const replayNextEvent = async (index: number) => {
          if (index >= sessionEvents.length) {
            setReplayingSession(null);
            alert("Session replay finished!");
            return;
          }

          const event = sessionEvents[index];
          setExpandedEvent(`${sessionId}_${index}`);

          chrome.tabs.sendMessage(
            tabId,
            { action: "REDO_ACTION", event },
            (response) => {
              if (chrome.runtime.lastError || !response?.success) {
                alert(
                  `Failed to replay action: ${
                    chrome.runtime.lastError?.message ||
                    response?.error ||
                    "Unknown error"
                  }`,
                );
                setReplayingSession(null);
                return;
              }
              // Wait a bit before the next action
              setTimeout(() => replayNextEvent(index + 1), 1000);
            },
          );
        };

        replayNextEvent(0);
      } else {
        alert("Could not find active tab to replay session on.");
        setReplayingSession(null);
      }
    });
  };

  const getEventIcon = (actionType: FlowEvent["actionType"]) => {
    const icons = {
      click: "🖱",
      input: "⌨️",
      submit: "✅",
      api_call: "🌐",
      route_change: "📍",
    };
    return icons[actionType] || "◆";
  };

  const getEventLabel = (event: FlowEvent) => {
    const meta = event.elementMetadata || {};
    if (event.actionType === "route_change")
      return `Navigate to ${event.route || "/"}`;
    if (event.actionType === "api_call")
      return `${event.apiDetails?.method} ${event.apiDetails?.endpoint}`;
    if (meta.innerText) return meta.innerText.substring(0, 50);
    if (meta.ariaLabel) return meta.ariaLabel.substring(0, 50);
    if (meta.id) return `#${meta.id}`;
    return `${event.actionType} on ${meta.tag || "element"}`;
  };

  if (loading) {
    return (
      <div className="flow-viewer">
        <p>Loading...</p>
      </div>
    );
  }

  if (allEvents.length === 0) {
    return (
      <div className="flow-viewer">
        <div className="empty-state">
          <p>No events recorded yet</p>
          <small>Start recording to see user interactions here</small>
        </div>
      </div>
    );
  }

  const sortedSessionIds = Object.keys(sessions).sort().reverse();

  return (
    <div className="flow-viewer">
      <div className="flow-header">
        <h2>Recorded Flow ({allEvents.length} total events)</h2>
        <button className="btn btn-secondary" onClick={handleExport}>
          📥 Export All
        </button>
      </div>

      <div className="sessions-list">
        {sortedSessionIds.map((sessionId) => (
          <details key={sessionId} className="session-group" open>
            <summary className="session-header">
              <div className="session-summary-title">
                <h4>
                  Session{" "}
                  {new Date(sessions[sessionId][0]?.timestamp).toLocaleString()}
                </h4>
                <small>{sessionId}</small>
              </div>
              <div className="session-controls">
                <span className="session-event-count">
                  {sessions[sessionId].length} events
                </span>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={(e) => {
                    e.preventDefault();
                    handleReplaySession(sessionId);
                  }}
                  disabled={replayingSession === sessionId}
                >
                  {replayingSession === sessionId ? "Replaying..." : "▶️ Replay Session"}
                </button>
              </div>
            </summary>
            <div className="events-list">
              {sessions[sessionId].map((event, index) => {
                const eventKey = `${sessionId}_${index}`;
                const isExpanded = expandedEvent === eventKey;
                return (
                  <div
                    key={eventKey}
                    className={`event-item ${isExpanded ? "expanded" : ""} ${
                      replayingSession === sessionId && isExpanded
                        ? "replaying"
                        : ""
                    }`}
                  >
                    <div
                      className="event-header"
                      onClick={() =>
                        setExpandedEvent(isExpanded ? null : eventKey)
                      }
                    >
                      <span className="event-icon">
                        {getEventIcon(event.actionType)}
                      </span>
                      <span className="event-label">
                        {getEventLabel(event)}
                      </span>
                      <span className="event-time">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="expand-icon">
                        {isExpanded ? "▼" : "▶"}
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="event-details">
                        <div className="detail-row">
                          <span className="detail-label">Type:</span>
                          <span className="detail-value">
                            {event.actionType}
                          </span>
                        </div>
                        <div className="detail-row">
                          <span className="detail-label">URL:</span>
                          <span className="detail-value detail-url">
                            {event.url}
                          </span>
                        </div>
                        {/* More details here */}
                        <div className="event-actions">
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleRedo(event)}
                          >
                            ↪️ Redo Action
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
