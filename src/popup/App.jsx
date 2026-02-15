import React from 'react';
import './App.css';
import RecorderControl from './components/RecorderControl';
import FlowViewer from './components/FlowViewer';
import AIPanel from './components/AIPanel';

export default function App() {
  const [view, setView] = React.useState('control'); // control, flow, ai
  const [isRecording, setIsRecording] = React.useState(false);
  const [eventCount, setEventCount] = React.useState(0);

  React.useEffect(() => {
    // Check recording status
    chrome.runtime.sendMessage(
      { action: 'GET_EVENTS' },
      (response) => {
        setEventCount(response.events?.length || 0);
      }
    );

    // Listen for updates
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

  return (
    <div className="app">
      <header className="header">
        <h1>🔴 Flow Recorder</h1>
        <div className="status">
          {isRecording && <span className="recording-badge">Recording...</span>}
          <span className="event-count">{eventCount} events</span>
        </div>
      </header>

      <nav className="nav">
        <button
          className={`nav-btn ${view === 'control' ? 'active' : ''}`}
          onClick={() => handleViewChange('control')}
        >
          Control
        </button>
        <button
          className={`nav-btn ${view === 'flow' ? 'active' : ''}`}
          onClick={() => handleViewChange('flow')}
        >
          Flow
        </button>
        <button
          className={`nav-btn ${view === 'ai' ? 'active' : ''}`}
          onClick={() => handleViewChange('ai')}
        >
          AI
        </button>
      </nav>

      <main className="main">
        {view === 'control' && (
          <RecorderControl onRecordingChange={setIsRecording} />
        )}
        {view === 'flow' && (
          <FlowViewer eventCount={eventCount} />
        )}
        {view === 'ai' && (
          <AIPanel />
        )}
      </main>

      <footer className="footer">
        <small>v1.0.0 | AI Flow Recorder</small>
      </footer>
    </div>
  );
}
