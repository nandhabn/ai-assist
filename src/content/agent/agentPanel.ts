// /Users/nandhagopalbomman/projects/AI/chrome-extension-flow-recorder/src/content/agentPanel.ts

/**
 * This file implements a floating UI panel for displaying live action predictions
 * and providing explainability and interaction features. It uses a Shadow DOM for
 * complete style isolation and has no external dependencies.
 */

import type { PredictionResult, RankedPrediction } from "@/types/ai";
import type { AgentStatus, AgentStep } from "../../utils/agentExecutor";

type ExecuteCallback = (prediction: RankedPrediction) => void;
type RecalculateCallback = () => void;
type AgentStartCallback = () => void;
type AgentStopCallback = () => void;
type AgentPauseCallback = () => void;
type AgentResumeCallback = () => void;

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

  .header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
  .header-title { font-weight: 600; color: #333; }
  .auto-badge { background-color: #e4f8e5; color: #28a745; padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; opacity: 0; transition: opacity 0.3s ease; }

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

  /* ---- Mission Prompt ---- */
  #mission-section {
    border-top: 1px solid #ede9fe;
    margin: 0;
  }
  #mission-toggle-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    cursor: pointer;
    user-select: none;
  }
  #mission-toggle-row:hover { background: #f5f3ff; }
  .mission-toggle-icon { font-size: 13px; }
  .mission-toggle-label {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: #5b21b6;
  }
  .mission-active-badge {
    display: none;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #7c3aed;
    padding: 2px 7px;
    border-radius: 10px;
  }
  .mission-active-badge.visible { display: inline-block; }
  .mission-chevron {
    font-size: 10px;
    color: #7c3aed;
    transition: transform 0.2s;
  }
  .mission-chevron.open { transform: rotate(180deg); }
  #mission-body {
    display: none;
    flex-direction: column;
    gap: 6px;
    padding: 0 10px 10px;
  }
  #mission-body.open { display: flex; }
  /* active mission text pill */
  #mission-active-row {
    display: none;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 8px;
    background: linear-gradient(135deg, #ede9fe 0%, #f5f3ff 100%);
    border: 1px solid #c4b5fd;
    border-radius: 6px;
  }
  #mission-active-row.visible { display: flex; }
  .mission-active-text {
    font-size: 11px;
    color: #5b21b6;
    flex: 1;
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    font-style: italic;
  }
  .mission-edit-btn, .mission-clear-icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    font-size: 11px;
    flex-shrink: 0;
    color: #7c3aed;
    line-height: 1;
  }
  .mission-edit-btn:hover, .mission-clear-icon-btn:hover { color: #5b21b6; }
  /* textarea input area */
  #mission-input-area { display: flex; flex-direction: column; gap: 5px; }
  .mission-textarea {
    width: 100%;
    resize: none;
    border: 1px solid #c4b5fd;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    font-family: inherit;
    color: #1f2937;
    background: #fff;
    line-height: 1.5;
    outline: none;
    box-sizing: border-box;
  }
  .mission-textarea::placeholder { color: #a78bfa; font-style: italic; }
  .mission-textarea:focus { border-color: #7c3aed; box-shadow: 0 0 0 2px rgba(124,58,237,0.15); }
  .mission-btn-row { display: flex; gap: 5px; justify-content: flex-end; }
  .mission-set-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 12px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    background: #7c3aed;
    color: #fff;
  }
  .mission-set-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .mission-set-btn:not(:disabled):hover { background: #6d28d9; }
  .mission-cancel-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border: 1px solid #c4b5fd;
    border-radius: 5px;
    cursor: pointer;
    background: transparent;
    color: #7c3aed;
  }
  .mission-cancel-btn:hover { background: #ede9fe; }

  /* ---- Agent Control ---- */
  #agent-control-section {
    border-top: 1px solid #e0e0e0;
    margin: 0;
  }
  #agent-control-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    justify-content: space-between;
  }
  .agent-control-label {
    font-size: 12px;
    font-weight: 600;
    color: #1f2937;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .agent-control-btns { display: flex; gap: 4px; }
  .agent-start-btn, .agent-stop-btn, .agent-pause-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
  }
  .agent-start-btn {
    background: #16a34a;
    color: #fff;
  }
  .agent-start-btn:hover { background: #15803d; }
  .agent-start-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .agent-stop-btn {
    background: #dc2626;
    color: #fff;
  }
  .agent-stop-btn:hover { background: #b91c1c; }
  .agent-pause-btn {
    background: #f59e0b;
    color: #fff;
  }
  .agent-pause-btn:hover { background: #d97706; }
  #agent-status-bar {
    display: none;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px 6px;
    font-size: 11px;
    color: #6b7280;
  }
  #agent-status-bar.visible { display: flex; }
  .agent-status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 5px;
  }
  .agent-status-dot.running  { background: #16a34a; animation: agent-pulse 1s infinite; }
  .agent-status-dot.planning  { background: #7c3aed; animation: agent-pulse 0.8s infinite; }
  .agent-status-dot.paused   { background: #f59e0b; }
  .agent-status-dot.completed, .agent-status-dot.stopped { background: #6b7280; }
  .agent-status-dot.error    { background: #dc2626; }
  .agent-status-dot.idle     { background: #d1d5db; }
  @keyframes agent-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  #agent-log {
    display: none;
    max-height: 120px;
    overflow-y: auto;
    padding: 0 12px 8px;
    font-size: 10px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    color: #374151;
  }
  #agent-log.visible { display: block; }
  .agent-log-entry {
    padding: 2px 0;
    border-bottom: 1px solid #f3f4f6;
    display: flex;
    gap: 4px;
  }
  .agent-log-step { color: #9ca3af; min-width: 22px; }
  .agent-log-action { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-log-ok { color: #16a34a; }
  .agent-log-fail { color: #dc2626; }
  #agent-plan {
    display: none;
    padding: 6px 12px 8px;
    font-size: 10px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    color: #4b5563;
    white-space: pre-wrap;
    line-height: 1.5;
    background: #f5f3ff;
    border-top: 1px solid #ede9fe;
  }
  #agent-plan.visible { display: block; }
  .agent-plan-header {
    font-size: 10px;
    font-weight: 700;
    color: #7c3aed;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }

  /* ---- Step detail tooltip ---- */
  #step-tooltip {
    display: none;
    position: fixed;
    z-index: 2147483647;
    background: #1e1e2e;
    color: #e5e7eb;
    font-size: 11px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    line-height: 1.65;
    padding: 8px 10px;
    border-radius: 7px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    max-width: 340px;
    white-space: pre-wrap;
    word-break: break-all;
    border: 1px solid #374151;
    cursor: text;
    user-select: text;
  }
  #step-tooltip.visible { display: block; }
  #step-tooltip .tt-label {
    font-weight: 700;
    color: #a78bfa;
    margin-bottom: 2px;
    display: block;
  }
  #step-tooltip .tt-row {
    display: flex;
    gap: 4px;
  }
  #step-tooltip .tt-key {
    color: #9ca3af;
    min-width: 64px;
    flex-shrink: 0;
  }
  #step-tooltip .tt-val {
    color: #e5e7eb;
    word-break: break-all;
  }
  #step-tooltip .tt-val.ok  { color: #4ade80; }
  #step-tooltip .tt-val.fail { color: #f87171; }
  #step-tooltip .tt-prompt {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid #374151;
    color: #c4b5fd;
    font-size: 10px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 160px;
    overflow-y: auto;
  }
  #step-tooltip .tt-prompt-label {
    font-size: 10px;
    font-weight: 700;
    color: #a78bfa;
    display: block;
    margin-bottom: 2px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ---- Theme toggle button ---- */
  .theme-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 5px;
    font-size: 14px;
    line-height: 1;
    border-radius: 5px;
    margin-left: 4px;
    opacity: 0.7;
    transition: opacity 0.2s, background 0.2s;
  }
  .theme-btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
  .panel-container.dark .theme-btn:hover { background: rgba(255,255,255,0.08); }

  /* ---- Collapse button ---- */
  .collapse-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 5px;
    font-size: 11px;
    line-height: 1;
    border-radius: 5px;
    margin-left: 2px;
    opacity: 0.7;
    transition: opacity 0.2s, background 0.2s, transform 0.2s;
  }
  .collapse-btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
  .panel-container.dark .collapse-btn:hover { background: rgba(255,255,255,0.08); }
  .collapse-btn.collapsed { transform: rotate(180deg); }

  /* ---- Collapsed state ---- */
  .panel-body {
    transition: all 0.2s ease;
  }
  .panel-container.collapsed .panel-body {
    display: none;
  }
  .panel-container.collapsed {
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
  }

  /* ---- Dark theme ---- */
  .panel-container.dark {
    background: #1e1e2e;
    border-color: #374151;
    box-shadow: 0 6px 16px rgba(0,0,0,0.4);
  }
  .panel-container.dark .header { border-bottom-color: #2d2d42; }
  .panel-container.dark .header-title { color: #e5e7eb; }
  .panel-container.dark .prediction-row:hover { background-color: #2d2d42; }
  .panel-container.dark .prediction-label { color: #e5e7eb; }
  .panel-container.dark .score-badge { background: #374151; color: #e5e7eb; }
  .panel-container.dark .run-btn { color: #60a5fa; }
  .panel-container.dark .run-btn:hover { color: #93c5fd; }
  .panel-container.dark .why-toggle { color: #9ca3af; }
  .panel-container.dark .why-details { background: #2d2d42; }
  .panel-container.dark .why-details pre { color: #d1d5db; }
  .panel-container.dark #mission-section { border-top-color: #2d2d42; }
  .panel-container.dark #mission-toggle-row:hover { background: #2d1f40; }
  .panel-container.dark .mission-toggle-label { color: #a78bfa; }
  .panel-container.dark .mission-chevron { color: #a78bfa; }
  .panel-container.dark #mission-active-row {
    background: linear-gradient(135deg, #2e1065 0%, #1e1527 100%);
    border-color: #4c1d95;
  }
  .panel-container.dark .mission-active-text { color: #c4b5fd; }
  .panel-container.dark .mission-edit-btn,
  .panel-container.dark .mission-clear-icon-btn { color: #a78bfa; }
  .panel-container.dark .mission-textarea {
    background: #12111c;
    border-color: #4c1d95;
    color: #e5e7eb;
  }
  .panel-container.dark .mission-textarea::placeholder { color: #7c3aed; }
  .panel-container.dark .mission-cancel-btn { border-color: #4c1d95; color: #a78bfa; }
  .panel-container.dark .mission-cancel-btn:hover { background: #2e1065; }
  .panel-container.dark #agent-control-section { border-top-color: #374151; }
  .panel-container.dark .agent-control-label { color: #e5e7eb; }
  .panel-container.dark #agent-status-bar { color: #9ca3af; }
  .panel-container.dark #agent-log { color: #9ca3af; }
  .panel-container.dark .agent-log-entry { border-bottom-color: #374151; }
  .panel-container.dark .agent-log-step { color: #6b7280; }
  .panel-container.dark #agent-plan {
    background: #1e1527;
    border-top-color: #4c1d95;
    color: #c4b5fd;
  }
  .panel-container.dark .agent-plan-header { color: #a78bfa; }

  /* ---- Steering Input ---- */
  #steering-section {
    display: none;
    border-top: 1px solid #e0e0e0;
    padding: 7px 10px 8px;
  }
  #steering-section.visible { display: block; }
  .steering-label {
    font-size: 11px;
    font-weight: 600;
    color: #374151;
    margin-bottom: 5px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .steering-hint-badge {
    display: none;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #f59e0b;
    padding: 1px 6px;
    border-radius: 10px;
    margin-left: auto;
  }
  .steering-hint-badge.visible { display: inline-block; }
  .steering-row {
    display: flex;
    gap: 5px;
    align-items: flex-end;
  }
  .steering-input {
    flex: 1;
    resize: none;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    color: #1f2937;
    background: #fff;
    line-height: 1.4;
    outline: none;
    box-sizing: border-box;
    max-height: 80px;
    overflow-y: auto;
  }
  .steering-input::placeholder { color: #9ca3af; font-style: italic; }
  .steering-input:focus { border-color: #f59e0b; box-shadow: 0 0 0 2px rgba(245,158,11,0.2); }
  .steering-submit-btn {
    font-size: 11px;
    font-weight: 700;
    padding: 5px 10px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    background: #f59e0b;
    color: #fff;
    white-space: nowrap;
    flex-shrink: 0;
    align-self: flex-end;
  }
  .steering-submit-btn:hover { background: #d97706; }
  .steering-submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .steering-queued-row {
    display: none;
    margin-top: 5px;
    padding: 4px 7px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 5px;
    font-size: 11px;
    color: #92400e;
    align-items: center;
    gap: 5px;
  }
  .steering-queued-row.visible { display: flex; }
  .steering-queued-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .steering-clear-btn { background: none; border: none; cursor: pointer; font-size: 11px; color: #92400e; padding: 0 2px; flex-shrink: 0; }
  .steering-clear-btn:hover { color: #78350f; }

  /* dark theme overrides for steering */
  .panel-container.dark #steering-section { border-top-color: #374151; }
  .panel-container.dark .steering-label { color: #d1d5db; }
  .panel-container.dark .steering-input {
    background: #12111c;
    border-color: #374151;
    color: #e5e7eb;
  }
  .panel-container.dark .steering-input::placeholder { color: #6b7280; }
  .panel-container.dark .steering-input:focus { border-color: #f59e0b; box-shadow: 0 0 0 2px rgba(245,158,11,0.2); }
  .panel-container.dark .steering-queued-row { background: #2d1f01; border-color: #78350f; color: #fcd34d; }
  .panel-container.dark .steering-clear-btn { color: #fcd34d; }
`;

const PANEL_ID = "flow-agent-panel-host";
let shadowRoot: ShadowRoot | null = null;
let onExecute: ExecuteCallback | null = null;
let onRecalculate: RecalculateCallback | null = null;
let onAgentStart: AgentStartCallback | null = null;
let onAgentStop: AgentStopCallback | null = null;
let onAgentPause: AgentPauseCallback | null = null;
let onAgentResume: AgentResumeCallback | null = null;

const originalStyles = new WeakMap<
  HTMLElement,
  { outline: string; outlineOffset: string }
>();
let lastTopSelector: string | null = null;

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
  agentCallbacks?: {
    onStart: AgentStartCallback;
    onStop: AgentStopCallback;
    onPause: AgentPauseCallback;
    onResume: AgentResumeCallback;
  },
) {
  if (shadowRoot) return;

  onExecute = executeCallback;
  onRecalculate = recalculateCallback;
  onAgentStart = agentCallbacks?.onStart || null;
  onAgentStop = agentCallbacks?.onStop || null;
  onAgentPause = agentCallbacks?.onPause || null;
  onAgentResume = agentCallbacks?.onResume || null;
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
        <span id="ai-thinking-indicator" class="ai-indicator"></span>
        <button id="theme-btn" class="theme-btn" title="Toggle dark mode">🌙</button>
        <button id="collapse-btn" class="collapse-btn" title="Collapse panel">▲</button>
      </div>
      <div class="panel-body">
      <div id="prediction-list"></div>
      <div id="mission-section">
        <div id="mission-toggle-row">
          <span class="mission-toggle-icon">🎯</span>
          <span class="mission-toggle-label">Mission Prompt</span>
          <span id="mission-active-badge" class="mission-active-badge">Active</span>
          <span id="mission-chevron" class="mission-chevron">▼</span>
        </div>
        <div id="mission-body">
          <div id="mission-active-row">
            <span id="mission-active-text" class="mission-active-text"></span>
            <button id="mission-edit-btn" class="mission-edit-btn" title="Edit">✏️</button>
            <button id="mission-clear-icon-btn" class="mission-clear-icon-btn" title="Clear">✕</button>
          </div>
          <div id="mission-input-area">
            <textarea id="mission-textarea" class="mission-textarea" rows="3"
              placeholder="Describe your goal across pages… e.g. &quot;Sign up with a test account and complete checkout&quot;"></textarea>
            <div class="mission-btn-row">
              <button id="mission-cancel-btn" class="mission-cancel-btn">Cancel</button>
              <button id="mission-set-btn" class="mission-set-btn">Set Mission</button>
            </div>
          </div>
        </div>
      </div>
      <div id="agent-control-section">
        <div id="agent-control-header">
          <span class="agent-control-label">🤖 Agent Mode</span>
          <div class="agent-control-btns">
            <button id="agent-pause-btn" class="agent-pause-btn" style="display:none;">⏸</button>
            <button id="agent-start-btn" class="agent-start-btn">▶ Start</button>
            <button id="agent-stop-btn" class="agent-stop-btn" style="display:none;">■ Stop</button>
          </div>
        </div>
        <div id="agent-status-bar">
          <span><span id="agent-status-dot" class="agent-status-dot idle"></span><span id="agent-status-text">Idle</span></span>
          <span id="agent-step-count">0 steps</span>
        </div>
        <div id="agent-plan"><div class="agent-plan-header">🧠 Plan</div><span id="agent-plan-text"></span></div>
        <div id="agent-log"></div>
      </div>
      <div id="steering-section">
        <div class="steering-label">
          💬 Steer Agent
          <span id="steering-hint-badge" class="steering-hint-badge">Queued</span>
        </div>
        <div class="steering-row">
          <textarea id="steering-input" class="steering-input" rows="2"
            placeholder="Type a one-time instruction… e.g. &quot;skip login, go to checkout&quot;"></textarea>
          <button id="steering-submit-btn" class="steering-submit-btn" disabled>Send</button>
        </div>
        <div id="steering-queued-row" class="steering-queued-row">
          <span id="steering-queued-text" class="steering-queued-text"></span>
          <button id="steering-clear-btn" class="steering-clear-btn" title="Clear">✕</button>
        </div>
      </div>
      </div>
    `;
  shadowRoot.appendChild(container);

  // Floating tooltip — appended to shadow root directly so it is never
  // clipped by the #agent-log overflow container.
  const stepTooltip = document.createElement("div");
  stepTooltip.id = "step-tooltip";
  shadowRoot.appendChild(stepTooltip);

  // ---- Collapse toggle ----
  const COLLAPSE_KEY = "flowAgent_collapsed";
  const collapseBtn = shadowRoot.getElementById(
    "collapse-btn",
  ) as HTMLButtonElement;
  const applyCollapsed = (collapsed: boolean) => {
    container.classList.toggle("collapsed", collapsed);
    collapseBtn.classList.toggle("collapsed", collapsed);
    collapseBtn.title = collapsed ? "Expand panel" : "Collapse panel";
  };
  chrome.storage.local.get(COLLAPSE_KEY, (data) => {
    applyCollapsed(data[COLLAPSE_KEY] === true);
  });
  collapseBtn.addEventListener("click", () => {
    const isCollapsed = !container.classList.contains("collapsed");
    chrome.storage.local.set({ [COLLAPSE_KEY]: isCollapsed });
    applyCollapsed(isCollapsed);
  });

  // Prevent keyboard events from leaking out of the agent panel into the page.
  // This stops page shortcuts from firing while the user types in any panel input.
  container.addEventListener("keydown", (e) => e.stopPropagation());
  container.addEventListener("keyup", (e) => e.stopPropagation());
  container.addEventListener("keypress", (e) => e.stopPropagation());

  // ---- Theme toggle (synced across all tabs via chrome.storage.local) ----
  const THEME_KEY = "flowAgent_darkTheme";
  const themeBtn = shadowRoot.getElementById("theme-btn") as HTMLButtonElement;
  const applyTheme = (dark: boolean) => {
    container.classList.toggle("dark", dark);
    themeBtn.textContent = dark ? "☀️" : "🌙";
    themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  };
  // Restore saved preference from chrome.storage.local (shared across all tabs)
  chrome.storage.local.get(THEME_KEY, (data) => {
    applyTheme(data[THEME_KEY] === true);
  });
  // Write to chrome.storage.local — the onChanged listener below will update all tabs
  themeBtn.addEventListener("click", () => {
    const isDark = !container.classList.contains("dark");
    chrome.storage.local.set({ [THEME_KEY]: isDark });
  });
  // Sync theme whenever any tab changes it
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && THEME_KEY in changes) {
      applyTheme(changes[THEME_KEY].newValue === true);
    }
  });

  // ---- Mission Prompt wiring ----
  const missionToggleRow = shadowRoot.getElementById("mission-toggle-row")!;
  const missionBody = shadowRoot.getElementById("mission-body")!;
  const missionChevron = shadowRoot.getElementById("mission-chevron")!;
  const missionActiveRow = shadowRoot.getElementById("mission-active-row")!;
  const missionActiveText = shadowRoot.getElementById("mission-active-text")!;
  const missionActiveBadge = shadowRoot.getElementById("mission-active-badge")!;
  const missionInputArea = shadowRoot.getElementById("mission-input-area")!;
  const missionTextarea = shadowRoot.getElementById(
    "mission-textarea",
  ) as HTMLTextAreaElement;
  const missionSetBtn = shadowRoot.getElementById(
    "mission-set-btn",
  ) as HTMLButtonElement;
  const missionCancelBtn = shadowRoot.getElementById(
    "mission-cancel-btn",
  ) as HTMLButtonElement;
  const missionEditBtn = shadowRoot.getElementById(
    "mission-edit-btn",
  ) as HTMLButtonElement;
  const missionClearIconBtn = shadowRoot.getElementById(
    "mission-clear-icon-btn",
  ) as HTMLButtonElement;

  const toggleMissionBody = (open: boolean) => {
    missionBody.classList.toggle("open", open);
    missionChevron.classList.toggle("open", open);
  };

  const showMissionActive = (text: string) => {
    missionActiveText.textContent = text;
    missionActiveRow.classList.add("visible");
    missionInputArea.style.display = "none";
    missionActiveBadge.classList.add("visible");
  };

  const showMissionInput = (prefill = "") => {
    missionActiveRow.classList.remove("visible");
    missionInputArea.style.display = "flex";
    missionTextarea.value = prefill;
    missionSetBtn.disabled = !prefill.trim();
    setTimeout(() => missionTextarea.focus(), 50);
  };

  const broadcastMission = (prompt: string) => {
    // Route through background so it can scope the mission to this tab's ID.
    chrome.runtime
      .sendMessage({ action: "SET_MISSION_PROMPT", prompt })
      .catch(() => {});
  };

  missionToggleRow.addEventListener("click", () => {
    const isOpen = missionBody.classList.contains("open");
    toggleMissionBody(!isOpen);
    // If opening with no mission yet, show input
    if (!isOpen && !missionActiveRow.classList.contains("visible")) {
      showMissionInput(missionTextarea.value);
    }
  });

  missionTextarea.addEventListener("input", () => {
    missionSetBtn.disabled = !missionTextarea.value.trim();
  });

  missionTextarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!missionSetBtn.disabled) missionSetBtn.click();
    }
  });

  missionSetBtn.addEventListener("click", () => {
    const text = missionTextarea.value.trim();
    if (!text) return;
    broadcastMission(text);
    showMissionActive(text);
    // content.ts picks it up via storage change listener
  });

  missionCancelBtn.addEventListener("click", () => {
    if (missionActiveRow.classList.contains("visible")) {
      missionInputArea.style.display = "none";
    } else {
      toggleMissionBody(false);
    }
  });

  missionEditBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMissionInput(missionActiveText.textContent || "");
  });

  missionClearIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    broadcastMission("");
    missionActiveRow.classList.remove("visible");
    missionActiveBadge.classList.remove("visible");
    missionTextarea.value = "";
    missionSetBtn.disabled = true;
    missionInputArea.style.display = "none";
    toggleMissionBody(false);
  });

  // Load this tab's persisted mission on init
  chrome.runtime
    .sendMessage({ action: "GET_MISSION_PROMPT" })
    .then((resp: { prompt?: string } | undefined) => {
      const saved = resp?.prompt || "";
      if (saved) showMissionActive(saved);
    })
    .catch(() => {});
  // ---- end Mission Prompt wiring ----

  // ---- Agent Control wiring ----
  const agentStartBtn = shadowRoot.getElementById(
    "agent-start-btn",
  ) as HTMLButtonElement;
  const agentStopBtn = shadowRoot.getElementById(
    "agent-stop-btn",
  ) as HTMLButtonElement;
  const agentPauseBtn = shadowRoot.getElementById(
    "agent-pause-btn",
  ) as HTMLButtonElement;

  agentStartBtn.addEventListener("click", () => {
    if (onAgentStart) onAgentStart();
  });

  agentStopBtn.addEventListener("click", () => {
    if (onAgentStop) onAgentStop();
  });

  agentPauseBtn.addEventListener("click", () => {
    // Toggle pause/resume
    const statusText = shadowRoot!.getElementById("agent-status-text");
    if (statusText?.textContent?.toLowerCase().includes("paused")) {
      if (onAgentResume) onAgentResume();
    } else {
      if (onAgentPause) onAgentPause();
    }
  });
  // ---- end Agent Control wiring ----

  // ---- Steering Input wiring ----
  const steeringInput = shadowRoot.getElementById("steering-input") as HTMLTextAreaElement;
  const steeringSubmitBtn = shadowRoot.getElementById("steering-submit-btn") as HTMLButtonElement;
  const steeringHintBadge = shadowRoot.getElementById("steering-hint-badge") as HTMLElement;
  const steeringQueuedRow = shadowRoot.getElementById("steering-queued-row") as HTMLElement;
  const steeringQueuedText = shadowRoot.getElementById("steering-queued-text") as HTMLElement;
  const steeringClearBtn = shadowRoot.getElementById("steering-clear-btn") as HTMLButtonElement;

  const showQueuedHint = (text: string) => {
    steeringQueuedText.textContent = `⏳ "${text}"`;
    steeringQueuedRow.classList.add("visible");
    steeringHintBadge.classList.add("visible");
    steeringInput.value = "";
    steeringSubmitBtn.disabled = true;
  };

  const clearQueuedHint = () => {
    steeringQueuedRow.classList.remove("visible");
    steeringHintBadge.classList.remove("visible");
    steeringQueuedText.textContent = "";
    // Also clear state so the hint is not sent to the AI
    import("../state").then(({ state }) => { state.currentSteeringHint = null; }).catch(() => {});
  };

  steeringInput.addEventListener("input", () => {
    steeringSubmitBtn.disabled = !steeringInput.value.trim();
  });

  steeringInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!steeringSubmitBtn.disabled) steeringSubmitBtn.click();
    }
  });

  steeringSubmitBtn.addEventListener("click", () => {
    const hint = steeringInput.value.trim();
    if (!hint) return;
    // Write into shared content-script state — prediction.ts will consume it on the next step
    import("../state").then(({ state }) => {
      state.currentSteeringHint = hint;
    }).catch(() => {});
    showQueuedHint(hint);
  });

  steeringClearBtn.addEventListener("click", () => clearQueuedHint());
  // ---- end Steering Input wiring ----

}

export function renderAgentPanel(result: PredictionResult) {
  if (!shadowRoot) return;

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

    // Highlight element outline on hover (visual only — no scroll)
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
    const focusBtn = document.createElement("button");
    focusBtn.className = "focus-btn";
    focusBtn.textContent = "⌖";
    focusBtn.title = "Focus element";
    focusBtn.onclick = (e) => {
      e.stopPropagation();
      const el = document.querySelector<HTMLElement>(pred.action.selector);
      if (el && document.contains(el)) {
        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
        el.focus();
      }
    };
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
    main.append(label, score, focusBtn, runBtn, whyToggle);

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

export function setMissionPrompt(text: string, _onClear?: () => void) {
  if (!shadowRoot) return;
  const missionActiveRow = shadowRoot.getElementById("mission-active-row");
  const missionActiveText = shadowRoot.getElementById("mission-active-text");
  const missionActiveBadge = shadowRoot.getElementById("mission-active-badge");
  const missionInputArea = shadowRoot.getElementById("mission-input-area");
  if (!missionActiveRow || !missionActiveText || !missionActiveBadge) return;
  if (text.trim()) {
    missionActiveText.textContent = text.trim();
    missionActiveRow.classList.add("visible");
    missionActiveBadge.classList.add("visible");
    if (missionInputArea) missionInputArea.style.display = "none";
  } else {
    missionActiveRow.classList.remove("visible");
    missionActiveBadge.classList.remove("visible");
  }
}

/**
 * Clears the "Queued" steering hint display once prediction.ts has consumed it.
 * Call this after the hint has been attached to the AI context.
 */
export function clearSteeringHintDisplay() {
  if (!shadowRoot) return;
  shadowRoot.getElementById("steering-queued-row")?.classList.remove("visible");
  shadowRoot.getElementById("steering-hint-badge")?.classList.remove("visible");
  const textEl = shadowRoot.getElementById("steering-queued-text");
  if (textEl) textEl.textContent = "";
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

/**
 * Update the agent control section to reflect current agent status.
 */
export function updateAgentControlUI(
  status: AgentStatus,
  stepCount: number,
  message?: string,
) {
  if (!shadowRoot) return;

  const startBtn = shadowRoot.getElementById(
    "agent-start-btn",
  ) as HTMLButtonElement | null;
  const stopBtn = shadowRoot.getElementById(
    "agent-stop-btn",
  ) as HTMLButtonElement | null;
  const pauseBtn = shadowRoot.getElementById(
    "agent-pause-btn",
  ) as HTMLButtonElement | null;
  const statusBar = shadowRoot.getElementById("agent-status-bar");
  const statusDot = shadowRoot.getElementById("agent-status-dot");
  const statusText = shadowRoot.getElementById("agent-status-text");
  const stepCountEl = shadowRoot.getElementById("agent-step-count");

  // Button visibility
  if (startBtn && stopBtn && pauseBtn) {
    if (status === "running") {
      startBtn.style.display = "none";
      stopBtn.style.display = "inline-block";
      pauseBtn.style.display = "inline-block";
      pauseBtn.textContent = "⏸";
    } else if (status === "paused") {
      startBtn.style.display = "none";
      stopBtn.style.display = "inline-block";
      pauseBtn.style.display = "inline-block";
      pauseBtn.textContent = "▶";
    } else {
      startBtn.style.display = "inline-block";
      stopBtn.style.display = "none";
      pauseBtn.style.display = "none";
    }
  }

  // Status bar
  if (statusBar) {
    statusBar.classList.toggle("visible", status !== "idle");
  }

  // Status dot
  if (statusDot) {
    statusDot.className = `agent-status-dot ${status}`;
  }

  // Status text
  if (statusText) {
    const labels: Record<string, string> = {
      idle: "Idle",
      planning: "Thinking…",
      running: "Running…",
      paused: "Paused",
      completed: "Completed",
      stopped: "Stopped",
      error: "Error",
    };
    statusText.textContent = message
      ? `${labels[status] || status} — ${message}`
      : labels[status] || status;
  }

  // Step count
  if (stepCountEl) {
    stepCountEl.textContent = `${stepCount} step${stepCount !== 1 ? "s" : ""}`;
  }

  // Steering input — only visible while the agent is actively working
  const steeringSection = shadowRoot.getElementById("steering-section");
  if (steeringSection) {
    steeringSection.classList.toggle("visible", status === "running" || status === "paused");
  }
}

/**
 * Append a step entry to the agent log. The log auto-scrolls to the bottom.
 */
export function appendAgentLogEntry(step: AgentStep) {
  if (!shadowRoot) return;
  const log = shadowRoot.getElementById("agent-log");
  if (!log) return;

  log.classList.add("visible");

  const entry = document.createElement("div");
  entry.className = "agent-log-entry";
  entry.innerHTML =
    `<span class="agent-log-step">${step.stepNumber}.</span>` +
    `<span class="agent-log-action">${escapeHtml(step.action)}</span>` +
    `<span class="${step.success ? "agent-log-ok" : "agent-log-fail"}">${step.success ? "✓" : "✗"}</span>`;

  // ── Tooltip: show full step details on hover ──────────────────────────
  const time = new Date(step.timestamp).toLocaleTimeString();
  const statusClass = step.success ? "ok" : "fail";
  const statusText = step.success ? "✓ success" : "✗ failed";

  // Build prompt section: prefer the full prompt stored on the step, fall back to tool-call params
  let promptHtml = "";
  if ((step as AgentStep & { prompt?: string }).prompt) {
    promptHtml =
      `<div class="tt-prompt"><span class="tt-prompt-label">📋 Prompt sent to AI</span>` +
      escapeHtml((step as AgentStep & { prompt?: string }).prompt!) +
      `</div>`;
  } else if (step.selector?.startsWith("__tool__:")) {
    try {
      const toolCall = JSON.parse(step.selector.slice("__tool__:".length)) as {
        tool?: string;
        params?: Record<string, unknown>;
      };
      const formatted = JSON.stringify(toolCall.params ?? toolCall, null, 2);
      promptHtml =
        `<div class="tt-prompt"><span class="tt-prompt-label">🤖 Tool Call</span>` +
        `tool: ${escapeHtml(toolCall.tool ?? "")}\nparams: ${escapeHtml(formatted)}</div>`;
    } catch {
      /* not valid JSON — skip */
    }
  }

  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const getTooltip = () => shadowRoot!.getElementById("step-tooltip");

  const buildTooltipContent = () =>
    `<span class="tt-label">Step ${step.stepNumber}</span>` +
    `<div class="tt-row"><span class="tt-key">Action</span><span class="tt-val">${escapeHtml(step.action)}</span></div>` +
    `<div class="tt-row"><span class="tt-key">Page</span><span class="tt-val">${escapeHtml(step.pageUrl)}</span></div>` +
    `<div class="tt-row"><span class="tt-key">Time</span><span class="tt-val">${time}</span></div>` +
    `<div class="tt-row"><span class="tt-key">Status</span><span class="tt-val ${statusClass}">${statusText}</span></div>` +
    promptHtml;

  const showTooltip = (e: MouseEvent) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const tooltip = getTooltip();
    if (!tooltip) return;
    tooltip.innerHTML = buildTooltipContent();
    tooltip.classList.add("visible");
    positionStepTooltip(tooltip, e);
  };

  const scheduleHide = () => {
    hideTimer = setTimeout(() => {
      getTooltip()?.classList.remove("visible");
      hideTimer = null;
    }, 120);
  };

  entry.addEventListener("mouseenter", showTooltip);
  entry.addEventListener("mousemove", (e) => {
    const tooltip = getTooltip();
    if (tooltip?.classList.contains("visible")) positionStepTooltip(tooltip, e);
  });
  entry.addEventListener("mouseleave", scheduleHide);

  // When the mouse moves onto the tooltip itself, cancel the pending hide
  // so it stays open and the user can read / select text.
  setTimeout(() => {
    const tooltip = getTooltip();
    if (!tooltip) return;
    tooltip.addEventListener("mouseenter", () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    tooltip.addEventListener("mouseleave", scheduleHide);
  }, 0);

  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

/** Show the AI-generated plan in the plan box. */
export function showAgentPlan(plan: string) {
  if (!shadowRoot) return;
  const box = shadowRoot.getElementById("agent-plan");
  const text = shadowRoot.getElementById("agent-plan-text");
  if (!box || !text) return;
  text.textContent = plan;
  box.classList.toggle("visible", plan.length > 0);
}

/** Clear the agent log (called on new agent start). */
export function clearAgentLog() {
  if (!shadowRoot) return;
  const log = shadowRoot.getElementById("agent-log");
  if (log) {
    log.innerHTML = "";
    log.classList.remove("visible");
  }
  // Also clear the plan box on fresh start
  showAgentPlan("");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Position the step tooltip near the mouse, keeping it on-screen. */
function positionStepTooltip(tooltip: HTMLElement, e: MouseEvent) {
  const PAD = 14;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const tw = tooltip.offsetWidth || 320;
  const th = tooltip.offsetHeight || 120;
  const left =
    e.clientX + PAD + tw > W ? e.clientX - tw - PAD : e.clientX + PAD;
  const top = e.clientY + th + PAD > H ? e.clientY - th - PAD : e.clientY + PAD;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export function toggleAgentPanelVisibility(visible: boolean) {
  const host = document.getElementById(PANEL_ID);

  if (host) {
    host.style.display = visible ? "block" : "none";
  }
}
