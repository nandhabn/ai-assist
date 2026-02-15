import React from 'react';
import '../styles/RecorderControl.css';

export default function RecorderControl({ onRecordingChange }) {
  const [isRecording, setIsRecording] = React.useState(false);
  const [buttonLoading, setButtonLoading] = React.useState(false);

  React.useEffect(() => {
    // Check initial recording status
    chrome.storage.local.get(['flowRecorder_isRecording'], (data) => {
      setIsRecording(data.flowRecorder_isRecording || false);
    });
  }, []);

  const handleStartRecording = async () => {
    setButtonLoading(true);
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'START_RECORDING' },
          () => resolve()
        );
      });

      setIsRecording(true);
      onRecordingChange(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to start recording');
    } finally {
      setButtonLoading(false);
    }
  };

  const handleStopRecording = async () => {
    setButtonLoading(true);
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'STOP_RECORDING' },
          () => resolve()
        );
      });

      setIsRecording(false);
      onRecordingChange(false);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      alert('Failed to stop recording');
    } finally {
      setButtonLoading(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Clear all recorded events?')) return;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'CLEAR_EVENTS' },
          () => resolve()
        );
      });

      alert('Events cleared');
    } catch (error) {
      console.error('Failed to clear events:', error);
    }
  };

  return (
    <div className="recorder-control">
      <div className="control-section">
        <h2>Recording Control</h2>

        <div className="button-group">
          <button
            className={`btn btn-primary ${isRecording ? 'btn-danger' : 'btn-success'}`}
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            disabled={buttonLoading}
          >
            {buttonLoading ? 'Loading...' : isRecording ? '⏹ Stop' : '⏽ Start'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={handleClear}
            disabled={buttonLoading || isRecording}
          >
            🗑 Clear
          </button>
        </div>

        <div className={`status-info ${isRecording ? 'recording' : 'idle'}`}>
          <p className="status-text">
            {isRecording ? '🔴 Recording active' : '⚫ Not recording'}
          </p>
          <p className="hint">
            {isRecording
              ? 'All interactions are being tracked'
              : 'Click Start to begin recording user interactions'}
          </p>
        </div>
      </div>

      <div className="info-section">
        <h3>What gets recorded:</h3>
        <ul className="feature-list">
          <li>✓ Clicks and button presses</li>
          <li>✓ Form inputs and submissions</li>
          <li>✓ Page navigation</li>
          <li>✓ API calls (fetch & XHR)</li>
          <li>✓ Element selectors (CSS & XPath)</li>
        </ul>
      </div>
    </div>
  );
}
