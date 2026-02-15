import React from 'react';
import '../styles/AIPanel.css';

export default function AIPanel() {
  const [aiData, setAIData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState('summary');

  React.useEffect(() => {
    loadAIData();
  }, []);

  const loadAIData = async () => {
    setLoading(true);
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'PREPARE_FOR_AI' }, resolve);
      });
      setAIData(response);
    } catch (error) {
      console.error('Failed to prepare flow:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPrompt = () => {
    if (aiData?.structuredPrompt) {
      navigator.clipboard.writeText(aiData.structuredPrompt);
      alert('Prompt copied to clipboard!');
    }
  };

  const handleExportMarkdown = () => {
    const content = `# Flow Analysis Report\n\n${aiData?.summary || ''}\n\n---\n\n${aiData?.structuredPrompt || ''}`;
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flow_report_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="ai-panel"><p>Loading...</p></div>;
  }

  if (!aiData) {
    return (
      <div className="ai-panel">
        <div className="empty-state">
          <p>No flow data to analyze</p>
          <small>Record some interactions first</small>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <h2>🤖 AI Flow Analysis</h2>
        <div className="ai-actions">
          <button className="btn btn-secondary btn-sm" onClick={loadAIData}>
            ⟲ Refresh
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyPrompt}>
            📋 Copy Prompt
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleExportMarkdown}>
            📄 Export
          </button>
        </div>
      </div>

      <div className="ai-tabs">
        <button
          className={`tab ${activeTab === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('summary')}
        >
          Summary
        </button>
        <button
          className={`tab ${activeTab === 'prompt' ? 'active' : ''}`}
          onClick={() => setActiveTab('prompt')}
        >
          LLM Prompt
        </button>
        <button
          className={`tab ${activeTab === 'metrics' ? 'active' : ''}`}
          onClick={() => setActiveTab('metrics')}
        >
          Metrics
        </button>
        <button
          className={`tab ${activeTab === 'tests' ? 'active' : ''}`}
          onClick={() => setActiveTab('tests')}
        >
          Test Points
        </button>
      </div>

      <div className="ai-content">
        {activeTab === 'summary' && (
          <div className="summary-view">
            <div className="markdown-content">
              {aiData.summary
                ? aiData.summary.split('\n').map((line, i) => (
                    <div key={i} className={getLevelClass(line)}>
                      {line}
                    </div>
                  ))
                : 'No summary available'}
            </div>
          </div>
        )}

        {activeTab === 'prompt' && (
          <div className="prompt-view">
            <div className="prompt-box">
              <pre>{aiData.structuredPrompt || 'No prompt generated'}</pre>
            </div>
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="metrics-view">
            <div className="metrics-grid">
              {aiData.metadata && Object.entries(aiData.metadata).map(
                ([key, value]) => (
                  <div key={key} className="metric-card">
                    <div className="metric-label">
                      {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                    </div>
                    <div className="metric-value">{value}</div>
                  </div>
                )
              )}
            </div>

            {aiData.apis && aiData.apis.length > 0 && (
              <>
                <h3>API Endpoints</h3>
                <div className="api-list">
                  {aiData.apis.map((api, i) => (
                    <div key={i} className="api-item">
                      <span className="method">{api.method}</span>
                      <span className="endpoint">{api.endpoint}</span>
                      <span className={`status ${api.status < 400 ? 'success' : 'error'}`}>
                        {api.status}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'tests' && (
          <div className="tests-view">
            {aiData.testPoints && aiData.testPoints.length > 0 ? (
              <div className="test-points">
                {aiData.testPoints.map((point, i) => (
                  <div key={i} className={`test-point priority-${point.priority}`}>
                    <h4>{point.type.replace(/_/g, ' ').toUpperCase()}</h4>
                    <p className="description">{point.description}</p>
                    <p className="suggestion">{point.suggestion}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p>No test points identified</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getLevelClass(line) {
  if (line.startsWith('##')) return 'heading-2';
  if (line.startsWith('#')) return 'heading-1';
  if (line.startsWith('- ')) return 'list-item';
  return 'paragraph';
}
