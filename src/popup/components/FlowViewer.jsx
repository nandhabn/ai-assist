import React from 'react';
import '../styles/FlowViewer.css';

export default function FlowViewer({ eventCount }) {
  const [events, setEvents] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [expandedIndex, setExpandedIndex] = React.useState(null);

  React.useEffect(() => {
    loadEvents();
  }, [eventCount]);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_EVENTS' }, resolve);
      });
      setEvents(response.events || []);
    } catch (error) {
      console.error('Failed to load events:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    const dataStr = JSON.stringify(events, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flow_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getEventIcon = (actionType) => {
    const icons = {
      click: '🖱',
      input: '⌨️',
      submit: '✅',
      api_call: '🌐',
      route_change: '📍',
    };
    return icons[actionType] || '◆';
  };

  const getEventLabel = (event) => {
    const meta = event.elementMetadata || {};

    if (event.actionType === 'route_change') {
      return `Navigate to ${event.route || '/'}`;
    }

    if (event.actionType === 'api_call') {
      return `${event.apiDetails.method} ${event.apiDetails.endpoint}`;
    }

    if (meta.innerText) {
      return meta.innerText.substring(0, 50);
    }

    if (meta.ariaLabel) {
      return meta.ariaLabel.substring(0, 50);
    }

    if (meta.id) {
      return `#${meta.id}`;
    }

    return `${event.actionType} on ${meta.tag || 'element'}`;
  };

  if (loading) {
    return <div className="flow-viewer"><p>Loading...</p></div>;
  }

  if (events.length === 0) {
    return (
      <div className="flow-viewer">
        <div className="empty-state">
          <p>No events recorded yet</p>
          <small>Start recording to see user interactions here</small>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-viewer">
      <div className="flow-header">
        <h2>Recorded Flow ({events.length} events)</h2>
        <button className="btn btn-secondary" onClick={handleExport}>
          📥 Export JSON
        </button>
      </div>

      <div className="events-list">
        {events.map((event, index) => (
          <div
            key={index}
            className={`event-item ${expandedIndex === index ? 'expanded' : ''}`}
          >
            <div
              className="event-header"
              onClick={() =>
                setExpandedIndex(expandedIndex === index ? null : index)
              }
            >
              <span className="event-icon">{getEventIcon(event.actionType)}</span>
              <span className="event-label">{getEventLabel(event)}</span>
              <span className="event-time">
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
              <span className="expand-icon">
                {expandedIndex === index ? '▼' : '▶'}
              </span>
            </div>

            {expandedIndex === index && (
              <div className="event-details">
                <div className="detail-row">
                  <span className="detail-label">Type:</span>
                  <span className="detail-value">{event.actionType}</span>
                </div>

                <div className="detail-row">
                  <span className="detail-label">URL:</span>
                  <span className="detail-value detail-url">{event.url}</span>
                </div>

                <div className="detail-row">
                  <span className="detail-label">Route:</span>
                  <span className="detail-value">{event.route}</span>
                </div>

                {event.elementMetadata && (
                  <>
                    <div className="detail-label">Element Metadata:</div>
                    <div className="detail-object">
                      {event.elementMetadata.tag && (
                        <div>Tag: {event.elementMetadata.tag}</div>
                      )}
                      {event.elementMetadata.id && (
                        <div>ID: {event.elementMetadata.id}</div>
                      )}
                      {event.elementMetadata.className && (
                        <div>Classes: {event.elementMetadata.className}</div>
                      )}
                      {event.elementMetadata.innerText && (
                        <div>Text: {event.elementMetadata.innerText}</div>
                      )}
                      {event.elementMetadata.ariaLabel && (
                        <div>ARIA Label: {event.elementMetadata.ariaLabel}</div>
                      )}
                    </div>
                  </>
                )}

                {event.selector && (
                  <>
                    <div className="detail-label">Selectors:</div>
                    <div className="detail-object">
                      {event.selector.css && (
                        <div>CSS: <code>{event.selector.css}</code></div>
                      )}
                      {event.selector.xpath && (
                        <div>XPath: <code>{event.selector.xpath}</code></div>
                      )}
                    </div>
                  </>
                )}

                {event.apiDetails && (
                  <>
                    <div className="detail-label">API Details:</div>
                    <div className="detail-object">
                      <div>Method: {event.apiDetails.method}</div>
                      <div>Status: {event.apiDetails.status}</div>
                      <div>Duration: {event.apiDetails.duration}ms</div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
