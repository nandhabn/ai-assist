// /Users/nandhagopalbomman/projects/AI/chrome-extension-flow-recorder/src/content/agentPanel.ts

/**
 * This file implements a floating UI panel for displaying live action predictions
 * and providing explainability and interaction features. It uses a Shadow DOM for
 * complete style isolation and has no external dependencies.
 */

import type {
  PredictionResult,
  RankedPrediction,
} from "../utils/predictionEngine";

type ExecuteCallback = (prediction: RankedPrediction) => void;
type RecalculateCallback = () => void;
type AutofillDataGenerator = (
  fields: { name: string; id: string; type: string; placeholder: string; labelText: string; ariaLabel: string; options?: string[] }[],
) => Promise<Record<string, string>>;

// Re-exporting for content.ts to use
export type { PredictionResult, RankedPrediction };

// --- CSS for the panel (injected into Shadow DOM) ---
const panelCss = `
  :host {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
  }
  .panel-container {
    width: 280px;
    background: #ffffff;
    border: 1px solid #e0e0e0;
    border-radius: 10px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.12);
    transition: border-color 0.3s ease, box-shadow 0.3s ease;
  }
  .panel-container.auto-executed { border-color: #28a745; }
  
  @keyframes confidence-boost-animation {
    0% { box-shadow: 0 6px 16px rgba(0,0,0,0.12); border-color: #e0e0e0; }
    50% { box-shadow: 0 6px 24px rgba(40, 167, 69, 0.4); border-color: #28a745; }
    100% { box-shadow: 0 6px 16px rgba(0,0,0,0.12); border-color: #e0e0e0; }
  }
  .panel-container.confidence-boost {
    animation: confidence-boost-animation 0.5s ease-in-out;
  }

  .header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
  .header-title { font-weight: 600; color: #333; }
  .auto-badge { background-color: #e4f8e5; color: #28a745; padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; opacity: 0; transition: opacity 0.3s ease; }
  .confidence-section { padding: 8px 12px; }
  .progress-bar-container { width: 100%; background-color: #e9ecef; border-radius: 5px; height: 10px; margin-top: 4px; overflow: hidden; }
  .progress-bar { height: 100%; width: 0; border-radius: 5px; transition: width 0.2s ease, background-color 0.2s ease; }
  .progress-bar.high { background-color: #28a745; }
  .progress-bar.medium { background-color: #ffc107; }
  .progress-bar.low { background-color: #dc3545; }
  .confidence-text { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #666; }

  .ai-indicator {
    display: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: #007bff;
    animation: ai-pulse 1.5s infinite ease-in-out;
  }
  @keyframes ai-pulse {
    0% { transform: scale(0.8); opacity: 0.5; }
    50% { transform: scale(1.2); opacity: 1; }
    100% { transform: scale(0.8); opacity: 0.5; }
  }

  #prediction-list { padding: 4px 8px; }
  .prediction-row { padding: 4px; border-radius: 5px; cursor: pointer; }
  .prediction-row:hover { background-color: #f5f5f5; }
  .prediction-main { display: flex; align-items: center; justify-content: space-between; }
  
  .prediction-label {
    flex-grow: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    color: #1f2937;
    font-weight: 500;
  }
  .score-badge {
    background: #e5e7eb;
    color: #111827;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 8px;
    margin-left: 8px;
  }
  .run-btn { font-size: 12px; font-weight: 500; color: #007bff; background: none; border: none; cursor: pointer; padding: 4px; }
  .run-btn:hover { color: #0056b3; }
  .why-toggle { font-size: 10px; border: none; background: none; padding: 2px; cursor: pointer; margin-left: 4px; }
  .why-details { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; background: #f8f9fa; border-radius: 4px; margin: 4px 8px 0; padding: 0 8px; }
  .why-details.visible { max-height: 150px; padding: 6px 8px; }
  .why-details pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 11px; margin: 0; white-space: pre-wrap; color: #333; }

  #autofill-assist {
    display: none; /* Hidden by default */
    padding: 8px 12px;
    margin: 4px 8px;
    background-color: #eef6ff;
    border: 1px solid #d0e7ff;
    border-radius: 6px;
    justify-content: space-between;
    align-items: center;
  }
  #autofill-assist.visible { display: flex; }
  .autofill-text { font-size: 12px; color: #1d4ed8; font-weight: 500; }
  .autofill-btn {
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background-color: #2563eb;
    border: none;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 5px;
  }
  .autofill-btn:hover { background-color: #1d4ed8; }
`;

const PANEL_ID = "flow-agent-panel-host";
let shadowRoot: ShadowRoot | null = null;
let onExecute: ExecuteCallback | null = null;
let onRecalculate: RecalculateCallback | null = null;
let onGenerateAutofillData: AutofillDataGenerator | null = null;
const originalStyles = new WeakMap<
  HTMLElement,
  { outline: string; outlineOffset: string }
>();
let lastTopSelector: string | null = null;
let currentFormFields:
  | {
      name: string;
      id: string;
      type: string;
      placeholder: string;
      labelText: string;
      ariaLabel: string;
      options?: string[];
    }[]
  | null = null;
let lastConfidence = 0.0;

// No hardcoded data generators — autofill data is now provided
// dynamically via the AutofillDataGenerator callback (AI-powered).



function getConfidenceClass(c: number): "high" | "medium" | "low" {
  return c >= 0.6 ? "high" : c >= 0.3 ? "medium" : "low";
}

function getHostElement(): HTMLElement {
  let host = document.getElementById(PANEL_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = PANEL_ID;
    host.dataset.flowRecorder = "true";
    document.body.appendChild(host);
  }
  return host;
}

export function initAgentPanel(
  executeCallback: ExecuteCallback,
  recalculateCallback: RecalculateCallback,
  autofillDataGenerator?: AutofillDataGenerator,
) {
  if (shadowRoot) return;

  onExecute = executeCallback;
  onRecalculate = recalculateCallback;
  onGenerateAutofillData = autofillDataGenerator || null;
  const host = getHostElement();
  shadowRoot = host.attachShadow({ mode: "open" });

  const styleSheet = new CSSStyleSheet();
  styleSheet.replaceSync(panelCss);
  shadowRoot.adoptedStyleSheets = [styleSheet];

  const container = document.createElement("div");
  container.className = "panel-container";
  container.innerHTML = `
      <div class="header">
        <span class="header-title">Flow Agent</span>
        <span class="auto-badge" id="auto-badge">Auto Executed</span>
      </div>
      <div class="confidence-section">
        <div class="confidence-text">
          <span>Confidence</span>
          <span>
            <span id="ai-thinking-indicator" class="ai-indicator"></span>
            <span id="confidence-percent">0%</span>
          </span>
        </div>
        <div class="progress-bar-container">
          <div id="confidence-bar" class="progress-bar"></div>
        </div>
      </div>
      <div id="prediction-list"></div>
      <div id="autofill-assist">
        <span class="autofill-text">Autofill Available</span>
        <button id="autofill-btn" class="autofill-btn">Fill Form</button>
      </div>
    `;
  shadowRoot.appendChild(container);

  shadowRoot.getElementById("autofill-btn")?.addEventListener("click", async () => {
    const btn = shadowRoot!.getElementById("autofill-btn") as HTMLButtonElement;
    const textEl = shadowRoot!.querySelector(".autofill-text") as HTMLElement;

    if (!currentFormFields || currentFormFields.length === 0) {
      console.warn("[Flow Agent] No form fields available for autofill");
      return;
    }

    if (!onGenerateAutofillData) {
      console.warn("[Flow Agent] No autofill data generator configured");
      return;
    }

    // Show loading state
    btn.disabled = true;
    btn.textContent = "Generating...";
    if (textEl) textEl.textContent = "AI is generating data...";

    try {
      const dataMap = await onGenerateAutofillData(currentFormFields);
      console.log("[Flow Agent] AI-generated data map:", dataMap);
      (window as any).__fillActiveForm(dataMap, { debug: true, delay: 50 });
    } catch (error) {
      console.error("[Flow Agent] Autofill data generation failed:", error);
      if (textEl) textEl.textContent = "Generation failed";
      setTimeout(() => {
        if (textEl) textEl.textContent = "Autofill Available";
      }, 2000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Fill Form";
      if (textEl) textEl.textContent = "Autofill Available";
    }
  });
}

export function renderAgentPanel(
  result: PredictionResult,
  autofillAvailable: boolean,
  formFields?: {
    name: string;
    id: string;
    type: string;
    placeholder: string;
    labelText: string;
    ariaLabel: string;
    options?: string[];
  }[],
) {
  if (!shadowRoot) return;

  currentFormFields = formFields || null;

  // Confidence Boost Animation
  const newConfidence = result.confidence;
  if (newConfidence > lastConfidence + 0.15) {
    const container = shadowRoot.querySelector(".panel-container");
    if (container) {
      container.classList.add("confidence-boost");
      setTimeout(() => container.classList.remove("confidence-boost"), 500);
    }
  }
  lastConfidence = newConfidence;

  // Update Confidence Bar
  const bar = shadowRoot.getElementById("confidence-bar") as HTMLElement;
  const percentText = shadowRoot.getElementById(
    "confidence-percent",
  ) as HTMLElement;

  if (newConfidence < 0.05) {
    percentText.textContent = "Exploring…";
    bar.style.width = "4%";
    bar.style.opacity = "0.6";
  } else {
    const confidencePercent = (newConfidence * 100).toFixed(0);
    percentText.textContent = `${confidencePercent}%`;
    bar.style.width = `${confidencePercent}%`;
    bar.style.opacity = "1";
  }

  bar.className = `progress-bar ${getConfidenceClass(newConfidence)}`;

  const autofillAssist = shadowRoot.getElementById(
    "autofill-assist",
  ) as HTMLElement;
  autofillAssist.classList.toggle("visible", autofillAvailable);

  const list = shadowRoot.getElementById("prediction-list") as HTMLElement;
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }

  if (result.topThree.length > 0) {
    lastTopSelector = result.topThree[0].action.selector;
  }

  result.topThree.forEach((pred) => {
    const row = document.createElement("div");
    row.className = "prediction-row";

    row.addEventListener("mouseenter", () => {
      if (
        onRecalculate &&
        (pred.action.selector !== lastTopSelector || result.confidence < 0.3)
      ) {
        onRecalculate();
      }

      const el = document.querySelector<HTMLElement>(pred.action.selector);
      if (el && document.contains(el)) {
        if (!originalStyles.has(el)) {
          originalStyles.set(el, {
            outline: el.style.outline,
            outlineOffset: el.style.outlineOffset,
          });
        }
        el.style.outline = "2px solid #00AEEF";
        el.style.outlineOffset = "2px";
        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
      }
    });

    row.addEventListener("mouseleave", () => {
      const el = document.querySelector<HTMLElement>(pred.action.selector);
      if (!el || !document.contains(el)) {
        if (el) originalStyles.delete(el);
        return;
      }
      if (originalStyles.has(el)) {
        const { outline, outlineOffset } = originalStyles.get(el)!;
        el.style.outline = outline;
        el.style.outlineOffset = outlineOffset;
        originalStyles.delete(el);
      }
    });

    const main = document.createElement("div");
    main.className = "prediction-main";
    const label = document.createElement("span");
    label.className = "prediction-label";
    label.textContent = pred.action.label;
    label.title = pred.action.label;
    const score = document.createElement("span");
    score.className = "score-badge";
    score.textContent = pred.totalScore.toFixed(2);
    const runBtn = document.createElement("button");
    runBtn.className = "run-btn";
    runBtn.textContent = "Run";
    runBtn.onclick = (e) => {
      e.stopPropagation();
      if (onExecute) onExecute(pred);
    };
    const whyToggle = document.createElement("button");
    whyToggle.className = "why-toggle";
    whyToggle.textContent = "▼";
    main.append(label, score, runBtn, whyToggle);

    const whyDetails = document.createElement("div");
    whyDetails.className = "why-details";
    const pre = document.createElement("pre");
    pre.textContent = Object.entries(pred.breakdown)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : v}`)
      .join("\n");
    whyDetails.appendChild(pre);
    whyToggle.onclick = (e) => {
      e.stopPropagation();
      whyDetails.classList.toggle("visible");
      whyToggle.textContent = whyDetails.classList.contains("visible")
        ? "▲"
        : "▼";
    };

    row.append(main, whyDetails);
    list.appendChild(row);
  });
}

export function setAIThinking(isThinking: boolean) {
  if (!shadowRoot) return;
  const indicator = shadowRoot.getElementById("ai-thinking-indicator");
  if (indicator) {
    indicator.style.display = isThinking ? "inline-block" : "none";
  }
}

export function flashAutoExecution() {
  if (!shadowRoot) return;

  const container = shadowRoot.querySelector(".panel-container");

  const badge = shadowRoot.getElementById("auto-badge");

  if (container && badge) {
    container.classList.add("auto-executed");

    badge.style.opacity = "1";

    setTimeout(() => {
      badge.style.opacity = "0";
    }, 1000);

    setTimeout(() => {
      container.classList.remove("auto-executed");
    }, 300);
  }
}

export function toggleAgentPanelVisibility(visible: boolean) {
  const host = document.getElementById(PANEL_ID);

  if (host) {
    host.style.display = visible ? "block" : "none";
  }
}
