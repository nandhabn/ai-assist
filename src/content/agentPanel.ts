// /Users/nandhagopalbomman/projects/AI/chrome-extension-flow-recorder/src/content/agentPanel.ts

/**
 * This file implements a floating UI panel for displaying live action predictions
 * and providing explainability and interaction features. It uses a Shadow DOM for
 * complete style isolation and has no external dependencies.
 */

import type { PredictionResult, RankedPrediction } from '../utils/predictionEngine';

type ExecuteCallback = (prediction: RankedPrediction) => void;
type RecalculateCallback = () => void;

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
    transition: border-color 0.3s ease;
  }
  .panel-container.auto-executed { border-color: #28a745; }
  .header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
  .header-title { font-weight: 600; color: #333; }
  .auto-badge { background-color: #e4f8e5; color: #28a745; padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; opacity: 0; transition: opacity 0.3s ease; }
  .confidence-section { padding: 8px 12px; }
  .progress-bar-container { width: 100%; background-color: #e9ecef; border-radius: 5px; height: 10px; margin-top: 4px; overflow: hidden; }
  .progress-bar { height: 100%; width: 0; border-radius: 5px; transition: width 0.2s ease, background-color 0.2s ease; }
  .progress-bar.high { background-color: #28a745; }
  .progress-bar.medium { background-color: #ffc107; }
  .progress-bar.low { background-color: #dc3545; }
  .confidence-text { display: flex; justify-content: space-between; font-size: 12px; color: #666; }

  #prediction-list { padding: 4px 8px; }
  .prediction-row { padding: 4px; border-radius: 5px; cursor: pointer; }
  .prediction-row:hover { background-color: #f5f5f5; }
  .prediction-main { display: flex; align-items: center; justify-content: space-between; }
  
  /* REQUIREMENT 2: FIX UNREADABLE LABELS */
  .prediction-label {
    flex-grow: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    /* FIXED STYLES */
    color: #1f2937;
    font-weight: 500;
  }
  .score-badge {
    /* FIXED STYLES */
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

  /* REQUIREMENT 1: AUTOFILL ASSIST UI */
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

const PANEL_ID = 'flow-agent-panel-host';
let shadowRoot: ShadowRoot | null = null;
let onExecute: ExecuteCallback | null = null;
let onRecalculate: RecalculateCallback | null = null;
const originalStyles = new WeakMap<HTMLElement, { outline: string; outlineOffset: string }>();
let lastTopSelector: string | null = null;
let currentFormFields: { name: string; type: string }[] | null = null;

function generateSmartData(fields: { name: string; type: string }[]): Record<string, string> {
    const data: Record<string, string> = {};
    const randomString = () => Math.random().toString(36).substring(7);

    for (const field of fields) {
        const name = field.name.toLowerCase();
        const type = field.type.toLowerCase();

        if (name.includes('email')) {
            data[field.name] = `${randomString()}@example.com`;
        } else if (type === 'password') {
            data[field.name] = `password${randomString()}`;
        } else if (name.includes('name')) {
            data[field.name] = 'John Doe';
        } else {
            data[field.name] = randomString();
        }
    }
    return data;
}

function getConfidenceClass(c: number): 'high' | 'medium' | 'low' {
    return c >= 0.6 ? 'high' : c >= 0.3 ? 'medium' : 'low';
}

function getHostElement(): HTMLElement {
    let host = document.getElementById(PANEL_ID);
    if (!host) {
        host = document.createElement('div');
        host.id = PANEL_ID;
        host.dataset.flowRecorder = 'true';
        document.body.appendChild(host);
    }
    return host;
}

export function initAgentPanel(executeCallback: ExecuteCallback, recalculateCallback: RecalculateCallback) {
    if (shadowRoot) return;

    onExecute = executeCallback;
    onRecalculate = recalculateCallback; // Store the recalculate callback
    const host = getHostElement();
    shadowRoot = host.attachShadow({ mode: 'open' });

    const styleSheet = new CSSStyleSheet();
    styleSheet.replaceSync(panelCss);
    shadowRoot.adoptedStyleSheets = [styleSheet];

    const container = document.createElement('div');
    container.className = 'panel-container';
    container.innerHTML = `
      <div class="header">
        <span class="header-title">Flow Agent</span>
        <span class="auto-badge" id="auto-badge">Auto Executed</span>
      </div>
      <div class="confidence-section">
        <div class="confidence-text">
          <span>Confidence</span>
          <span id="confidence-percent">0%</span>
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

    // Add listener for the autofill button
    shadowRoot.getElementById('autofill-btn')?.addEventListener('click', () => {
        if (currentFormFields) {
            (window as any).__fillActiveForm(generateSmartData(currentFormFields));
        }
    });
}

export function renderAgentPanel(result: PredictionResult, autofillAvailable: boolean, formFields?: { name: string; type: string }[]) {
    if (!shadowRoot) return;

    currentFormFields = formFields || null;

    // 1. Update Confidence Bar
    const confidence = result.confidence;
    const bar = shadowRoot.getElementById('confidence-bar') as HTMLElement;
    const percentText = shadowRoot.getElementById('confidence-percent') as HTMLElement;

    if (confidence < 0.05) {
      percentText.textContent = "Exploring…";
      bar.style.width = '4%';
      bar.style.opacity = '0.6';
    } else {
      const confidencePercent = (confidence * 100).toFixed(0);
      percentText.textContent = `${confidencePercent}%`;
      bar.style.width = `${confidencePercent}%`;
      bar.style.opacity = '1';
    }
    
    bar.className = `progress-bar ${getConfidenceClass(confidence)}`;

    // 2. Update Autofill Assist Visibility
    const autofillAssist = shadowRoot.getElementById('autofill-assist') as HTMLElement;
    autofillAssist.classList.toggle('visible', autofillAvailable);

    // 3. Update Predictions List
    const list = shadowRoot.getElementById('prediction-list') as HTMLElement;
    while (list.firstChild) {
        list.removeChild(list.firstChild);
    }

    if (result.topThree.length > 0) {
        lastTopSelector = result.topThree[0].action.selector;
    }

    result.topThree.forEach(pred => {
        const row = document.createElement('div');
        row.className = 'prediction-row';

        // Consolidated mouseenter listener
        row.addEventListener('mouseenter', () => {
            if (onRecalculate && (pred.action.selector !== lastTopSelector || result.confidence < 0.3)) {
                onRecalculate();
            }

            const el = document.querySelector<HTMLElement>(pred.action.selector);
            if (el && document.contains(el)) {
                if (!originalStyles.has(el)) {
                    originalStyles.set(el, { outline: el.style.outline, outlineOffset: el.style.outlineOffset });
                }
                el.style.outline = '2px solid #00AEEF';
                el.style.outlineOffset = '2px';
            }
        });
        
        row.addEventListener('mouseleave', () => {
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

        const main = document.createElement('div');
        main.className = 'prediction-main';
        const label = document.createElement('span');
        label.className = 'prediction-label';
        label.textContent = pred.action.label;
        label.title = pred.action.label;
        const score = document.createElement('span');
        score.className = 'score-badge';
        score.textContent = pred.totalScore.toFixed(2);
        const runBtn = document.createElement('button');
        runBtn.className = 'run-btn';
        runBtn.textContent = 'Run';
        runBtn.onclick = (e) => { e.stopPropagation(); if (onExecute) onExecute(pred); };
        const whyToggle = document.createElement('button');
        whyToggle.className = 'why-toggle';
        whyToggle.textContent = '▼';
        main.append(label, score, runBtn, whyToggle);

        const whyDetails = document.createElement('div');
        whyDetails.className = 'why-details';
        const pre = document.createElement('pre');
        pre.textContent = Object.entries(pred.breakdown).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`).join('\n');
        whyDetails.appendChild(pre);
        whyToggle.onclick = (e) => {
            e.stopPropagation();
            whyDetails.classList.toggle('visible');
            whyToggle.textContent = whyDetails.classList.contains('visible') ? '▲' : '▼';
        };

        row.append(main, whyDetails);
        list.appendChild(row);
    });
}

export function flashAutoExecution() {
    if (!shadowRoot) return;
    const container = shadowRoot.querySelector('.panel-container');
    const badge = shadowRoot.getElementById('auto-badge');
    if (container && badge) {
        container.classList.add('auto-executed');
        badge.style.opacity = '1';
        setTimeout(() => { badge.style.opacity = '0'; }, 1000);
        setTimeout(() => { container.classList.remove('auto-executed'); }, 300);
    }
}