import { RankedPrediction, PredictionResult } from "../types/ai";

const PANEL_ID = "__flow-agent-panel__";
let onExecuteCallback: (prediction: RankedPrediction) => void;
let autoModeEnabled = false;

const getConfidenceColor = (confidence: number): string => {
  if (confidence > 0.6) return "#4caf50"; // green
  if (confidence > 0.3) return "#ffeb3b"; // yellow
  return "#f44336"; // red
};

const panelStyle = `
  :host {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 260px;
    background-color: #2c2c2e;
    color: #f5f5f7;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    z-index: 2147483647;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .header {
    padding: 10px 12px;
    background-color: #3a3a3c;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .confidence-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .confidence-bar {
    width: 50px;
    height: 8px;
    background-color: #555;
    border-radius: 4px;
    overflow: hidden;
  }
  .confidence-fill {
    height: 100%;
    width: 0%;
    background-color: #f44336;
    transition: width 0.3s, background-color 0.3s;
  }
  .predictions {
    display: flex;
    flex-direction: column;
    padding: 8px 0;
  }
  .prediction-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #444;
  }
  .prediction-item:last-child {
    border-bottom: none;
  }
  .prediction-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-right: 8px;
  }
  .run-button {
    background-color: #007aff;
    color: white;
    border: none;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .run-button:hover {
    background-color: #0056b3;
  }
  .footer {
    padding: 8px 12px;
    background-color: #3a3a3c;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .automode-label {
    cursor: pointer;
    user-select: none;
  }
`;

export function initAgentPanel(
  onExecute: (prediction: RankedPrediction) => void,
): void {
  if (document.getElementById(PANEL_ID)) return;

  onExecuteCallback = onExecute;

  const rootEl = document.createElement("div");
  rootEl.id = PANEL_ID;
  rootEl.dataset.flowRecorder = "true";
  document.body.appendChild(rootEl);

  const shadowRoot = rootEl.attachShadow({ mode: "open" });

  const styleSheet = new CSSStyleSheet();
  styleSheet.replaceSync(panelStyle);
  shadowRoot.adoptedStyleSheets = [styleSheet];

  shadowRoot.innerHTML = `
    <div class="header">
      <span>Flow Agent</span>
      <div class="confidence-indicator">
        <span id="confidence-percent">--%</span>
        <div class="confidence-bar">
          <div id="confidence-fill" class="confidence-fill"></div>
        </div>
      </div>
    </div>
    <div id="predictions-list" class="predictions"></div>
    <div class="footer">
      <input type="checkbox" id="automode-toggle" />
      <label for="automode-toggle" class="automode-label">Auto Mode</label>
    </div>
  `;

  const automodeToggle = shadowRoot.getElementById(
    "automode-toggle",
  ) as HTMLInputElement;
  automodeToggle.addEventListener("change", () => {
    autoModeEnabled = automodeToggle.checked;
  });
}

export function renderAgentPanel(result: PredictionResult): void {
  const shadowRoot = document.getElementById(PANEL_ID)?.shadowRoot;
  if (!shadowRoot) return;

  updateConfidenceIndicator(result.confidence);

  const predictionsList = shadowRoot.getElementById("predictions-list");
  if (!predictionsList) return;

  predictionsList.innerHTML = ""; // Clear previous predictions

  result.topThree.forEach((prediction, index) => {
    const item = document.createElement("div");
    item.className = "prediction-item";

    const label = document.createElement("span");
    label.className = "prediction-label";
    label.textContent = prediction.action.label;
    label.title = prediction.action.label;
    item.appendChild(label);

    const runButton = document.createElement("button");
    runButton.className = "run-button";
    runButton.textContent = "Run";
    runButton.onclick = () => onExecuteCallback(prediction);
    item.appendChild(runButton);

    predictionsList.appendChild(item);
  });

  if (
    autoModeEnabled &&
    result.confidence > 0.6 &&
    result.topThree.length > 0
  ) {
    onExecuteCallback(result.topThree[0]);
  }
}

export function updateConfidenceIndicator(confidence: number): void {
  const shadowRoot = document.getElementById(PANEL_ID)?.shadowRoot;
  if (!shadowRoot) return;

  const confidencePercent = shadowRoot.getElementById(
    "confidence-percent",
  ) as HTMLSpanElement;
  const confidenceFill = shadowRoot.getElementById(
    "confidence-fill",
  ) as HTMLDivElement;

  if (confidencePercent && confidenceFill) {
    const percent = Math.round(confidence * 100);
    confidencePercent.textContent = `${percent}%`;
    confidenceFill.style.width = `${percent}%`;
    confidenceFill.style.backgroundColor = getConfidenceColor(confidence);
  }
}
