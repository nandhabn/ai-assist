# AI Flow Agent — Project Context for AI Assistants

**👋 For AI Assistants**: Read this file FIRST when working on this codebase. It contains essential architecture, data flow, and conventions that will help you make accurate, consistent changes.

This document gives AI assistants (and developers) enough context to work effectively in this codebase. Read it before making changes.

## 🔄 Maintenance Note

**IMPORTANT**: This file must be kept in sync with code changes. When you modify:

- Architecture (new files, modules, or major refactors)
- Data structures (types, interfaces, storage keys)
- Message protocols (background ↔ content ↔ popup)
- Build configuration or entry points
- AI provider interfaces or behavior
- Key algorithms (prediction scoring, context building)

**Update this agent.md file accordingly.** This ensures future AI assistants and developers have accurate information.

---

## 1. Project Overview

**AI Flow Agent** is a **Chrome Extension (Manifest V3)** that:

1. **Observes** user interactions on web pages (clicks, inputs, focus, submit).
2. **Builds** structured page context (intent, visible actions, forms, viewport).
3. **Predicts** the user’s next likely action using deterministic scoring first, with optional AI fallback (Gemini / ChatGPT) when confidence is low.
4. **Displays** live predictions in a Shadow DOM panel with explainability and form autofill assist.
5. **Records** flows for test-automation and analysis (local-first; no backend required for recording or the agent).

**Architecture priorities:**

- **Deterministic prediction first** — AI only when confidence is low.
- **Strong performance guards** — throttle, debounce, cooldown, mutex.
- **Provider-agnostic AI** — swappable Gemini/ChatGPT via `AIProvider` interface.
- **UI isolation** — Agent panel in Shadow DOM; no global CSS pollution.
- **Stable, demo-ready UX** — no prediction storms, no layout thrashing.

---

## 2. High-Level Architecture

```
Content Script
   ├── Interaction Capture
   ├── Page Context Builder
   ├── Deterministic Prediction Engine
   ├── AI Fallback Orchestrator
   ├── Autofill Assist Detection
   └── Shadow DOM Agent Panel

AI Layer
   ├── AIProvider interface
   ├── GeminiProvider
   ├── ChatGPTProvider
   ├── ChatGPTTabProvider (bridge via tab)
   ├── NovaProvider
   ├── BatchingProvider (wrapper)
   ├── AIQueue (request queue)
   └── aiProviderFactory

Config Layer
   └── AI_CONFIG (from Vite .env)
```

---

## 3. Tech Stack

| Layer      | Technology                                                       |
| ---------- | ---------------------------------------------------------------- |
| Language   | TypeScript                                                       |
| UI (popup) | React 18, CSS modules                                            |
| Build      | Vite 5 (two configs: main + content script)                      |
| Extension  | Manifest V3, service worker, content script, ES modules          |
| AI         | Pluggable providers (Gemini, ChatGPT) via `AIProvider` interface |

- **Path alias**: `@` → `src/` (e.g. `@/utils/storage`, `@/types/index`).
- **Linting/check**: `npm run check` runs `tsc -b`.

---

## 4. Repository Layout (Relevant Paths)

```
chrome-extension-flow-recorder/
├── public/
│   └── manifest.json               # Extension manifest (MV3)
├── src/
│   ├── background/
│   │   └── background.ts           # Service worker: messaging, storage, tab broadcast
│   ├── config/
│   │   ├── aiConfig.ts             # API key config from VITE_* env vars
│   │   └── prompts.ts              # AI prompt templates
│   ├── content/
│   │   ├── content.ts              # Main content script: recording + agent orchestration
│   │   ├── chatgptBridge.ts        # Bridge script for ChatGPT tab provider
│   │   ├── state.ts                # Content-script shared state
│   │   ├── agent/
│   │   │   ├── agentManager.ts     # Agent lifecycle and prediction scheduling
│   │   │   ├── agentPanel.ts       # Floating AI panel (Shadow DOM)
│   │   │   ├── execution.ts        # Execute predicted actions
│   │   │   └── prediction.ts       # Prediction wiring in content context
│   │   ├── ai/
│   │   │   ├── providers.ts        # AI provider instantiation for content
│   │   │   └── rateLimit.ts        # AI call rate limiting
│   │   ├── form/
│   │   │   ├── autofill.ts         # Form autofill assist
│   │   │   └── formDetect.ts       # Active form detection
│   │   └── ui/
│   │       ├── flyout.ts           # Flyout overlay UI
│   │       └── flyout.css
│   ├── popup/
│   │   ├── popup.html
│   │   ├── main.tsx                # React entry point
│   │   ├── App.tsx                 # Tabs: Control | Flow | AI
│   │   ├── App.css
│   │   ├── components/
│   │   │   ├── RecorderControl.tsx # Start/Stop/Clear, Agent toggle
│   │   │   ├── FlowViewer.tsx      # Recorded event list and export
│   │   │   ├── AIPanel.tsx         # AI analysis, prompts, export
│   │   │   ├── Dashboard.tsx       # Summary dashboard
│   │   │   └── MissionBar.tsx / .css
│   │   └── styles/                 # Component CSS
│   ├── types/
│   │   ├── index.ts                # RecordedEvent, FlowNode/Edge, ACTION_TYPES, ElementMetadata
│   │   └── ai.ts                   # AIProvider, CompactContext, AIPrediction
│   ├── ui/
│   │   └── agentPanel.ts           # Panel render helpers
│   └── utils/
│       ├── storage.ts              # chrome.storage.local wrapper
│       ├── selectorGenerator.ts    # CSS selector & XPath generation
│       ├── elementAnalyzer.ts      # ElementMetadata, form helpers
│       ├── navigationDetector.ts   # SPA route-change detection
│       ├── apiInterceptor.ts       # Fetch/XHR interception
│       ├── flowAnalyzer.ts         # analyzeEventFlow, detectForms, identifyTestPoints
│       ├── aiFormatter.ts          # prepareFlowData, JSON/Markdown export
│       ├── contextBuilder.ts       # Full PageContext builder
│       ├── predictionEngine.ts     # generatePredictions, maybeUseAI, fillFormFields
│       ├── aiProviderFactory.ts    # createAIProvider(name, apiKey)
│       ├── geminiProvider.ts       # GeminiProvider
│       ├── chatgptProvider.ts      # ChatGPTProvider (OpenAI)
│       ├── chatgptTabProvider.ts   # ChatGPT via tab bridge
│       ├── novaProvider.ts         # Nova provider
│       ├── batchingProvider.ts     # Batching wrapper
│       ├── aiQueue.ts              # AI request queue
│       └── agentExecutor.ts        # Agent action executor
├── vite.config.ts                  # Popup + background build; copies popup.html & manifest to dist
├── vite.config.content.ts          # Content script build (does not clear dist)
├── .env / .env.example             # API keys (VITE_*); never commit .env
└── dist/                           # Output: popup.html, popup.js, background.js, content.js, manifest.json
```

---

## 5. Build & Load

- **`npm run build`**: Two Vite builds:
  - `vite build` — popup (`popup.html`, `popup.js`) and background service worker (`background.js`).
  - `vite build --config vite.config.content.ts` — content script (`content.js`) and ChatGPT bridge (`chatgptBridge.js`).
- **`npm run dev`**: Vite dev + content script watch (two processes).
- **`npm run check`**: `tsc -b` type-check.
- **Load in Chrome**: `chrome://extensions` → Enable Developer mode → Load unpacked → select `dist/`.
- Content script is injected on `<all_urls>`, `document_end`, `all_frames: true`.

---

## 6. Core Data Types (Quick Reference)

- **`RecordedEvent`** (`types/index.ts`): `sessionId`, `timestamp`, `url`, `route`, `actionType`, `elementMetadata?`, `selector?`, `apiDetails?`.
- **`ActionType`**: `click` | `input` | `submit` | `api_call` | `route_change` (from `ACTION_TYPES`).
- **`ElementMetadata`**: `tag`, `id`, `className`, `innerText`, `name`, `type`, `role`, `ariaLabel`, `dataTestId`, `parentForm?`, `value?`, `boundingBox?`.
- **`PageContext`** (used by prediction engine in `content.ts` and `predictionEngine.ts`): `pageIntent`, `visibleActions`, `forms`, `lastUserAction`, `lastActionRect`, `viewport`. Note: `content.ts` builds a **simplified** `PageContext` inline; `contextBuilder.ts` exports a **richer** `buildPageContext(lastUserAction)` with `url`, `title`, `timestamp` and different `Form`/`ActionCandidate` shapes. The prediction engine expects the simplified shape (with `viewport` and `forms` as `Form[]` with `selector`, `completionScore`, `fields`).
- **`PredictionResult`**: `{ topThree: RankedPrediction[], confidence: number }`.
- **`RankedPrediction`**: `{ action: ActionCandidate, totalScore, breakdown }`.
- **`AIProvider`** (`types/ai.ts`): `predictNextAction(context: CompactContext): Promise<AIPrediction>`.
- **`CompactContext`**: `pageIntent`, `lastActionLabel?`, `topVisibleActions`, `formFields`.
- **`AIPrediction`**: `predictedActionLabel`, `reasoning`, `confidenceEstimate`.

---

## 7. Message Protocol (Background ↔ Content / Popup)

Handled in `background/background.ts`:

| Action               | Sender  | Behavior                                                 |
| -------------------- | ------- | -------------------------------------------------------- |
| `START_RECORDING`    | Popup   | Persists state; broadcasts to all tabs                   |
| `STOP_RECORDING`     | Popup   | Persists state; broadcasts to all tabs                   |
| `GET_EVENTS`         | Popup   | Returns stored events                                    |
| `CLEAR_EVENTS`       | Popup   | Clears events from storage                               |
| `GET_SESSION_ID`     | Popup   | Returns current session ID                               |
| `SAVE_SESSION`       | Popup   | Appends current events as a saved session; clears events |
| `GENERATE_AI_SCRIPT` | Popup   | Uses `prepareFlowData`; currently returns mocked result  |
| `TOGGLE_AGENT`       | Popup   | Enables/disables the agent panel on all tabs             |
| `EVENT_RECORDED`     | Content | Keeps service worker alive; no processing                |

Popup and content script talk to the background via `chrome.runtime.sendMessage`; background uses `chrome.tabs.sendMessage` to notify tabs.

---

## 8. Storage Keys (`utils/storage.ts`)

- `flowRecorder_events` — array of recorded events
- `flowRecorder_sessionId` — current session ID
- `flowRecorder_isRecording` — boolean
- `flowRecorder_sessions` — saved sessions
- `flowRecorder_lastUserAction` — last event (for agent context / form autofill)
- `flowRecorder_agentEnabled` — whether Flow Agent is on (default true)

All are in `chrome.storage.local`.

---

## 9. Core Module: Content Script (`content/content.ts`)

**Subdirectory layout:**

- `content/agent/` — `agentManager.ts` (lifecycle/scheduling), `agentPanel.ts` (Shadow DOM UI), `execution.ts` (run predicted action), `prediction.ts` (prediction wiring)
- `content/ai/` — `providers.ts` (instantiate AI providers), `rateLimit.ts` (rate limiting)
- `content/form/` — `autofill.ts` (form fill assist), `formDetect.ts` (active form detection)
- `content/ui/` — `flyout.ts` / `flyout.css` (flyout overlay)
- `content/state.ts` — shared content-script state
- `content/chatgptBridge.ts` — bridge script for ChatGPT tab provider

**Responsibilities:**

- Capture click / input / focus / submit events.
- Track `lastRecordedEvent`.
- Detect active form for autofill.
- Build `PageContext`.
- Run deterministic predictions; optionally run AI fallback.
- Render Agent Panel.
- Apply throttling, debouncing, cooldown; guard against prediction storms.

**Performance guards:**

- `throttle()` for mousemove.
- `scheduleUpdate()` with debounce (100ms).
- `isUpdating` mutex for async protection.
- `AI_COOLDOWN` (e.g. 2000ms).
- `lastHoveredElement` prevents redundant recalculations.
- `lastPrediction` prevents flickering (inertia logic).

**Initialization:**

- Avoids duplicate listeners via `window.__flowRecorderListenersAttached`.
- Restores `isRecording`, `sessionId`, `isAgentGloballyEnabled` from storage.
- Adds listeners for click, input, focusin, submit.
- If agent enabled: `initializeAgent()` (panel, mousemove, first prediction).

**Recording:**

- On interaction, finds closest interactive element, builds event with `extractElementMetadata`, `generateCSSSelector`, `generateXPath`, route/URL from `navigationDetector`, then `saveEvent` and `saveLastUserAction`; if recording, also `chrome.runtime.sendMessage({ action: "EVENT_RECORDED", event })`.
- Elements inside `[data-flow-recorder]` are excluded from prediction.
- Focusin can set `activeFormForAutofill` / `activeFormFields` for the agent panel’s “Fill Form” button.

**Agent (predictions):**

- Page context built inline as `buildPageContext()`; updates triggered on mousemove (throttled) and after capture via `updateAgentPredictions()`.
- Pipeline: `buildPageContext()` → `generatePredictions(context)` → if confidence < 0.2 and AI cooldown passed, `maybeUseAI(context, result, aiProvider)`.
- AI provider lazily created from `aiConfig` (Gemini preferred, then ChatGPT). API keys from `import.meta.env.VITE_*` (build-time).
- Execution: “Run” in panel → `onExecutePrediction(prediction)` → `document.querySelector(prediction.action.selector)?.click()`.

---

## 10. Prediction Engine (`utils/predictionEngine.ts`)

**Strategy:** Weighted deterministic scoring:

| Factor    | Weight |
| --------- | ------ |
| PROXIMITY | 0.30   |
| INTENT    | 0.25   |
| FORM      | 0.25   |
| ROLE      | 0.10   |
| DIRECTION | 0.10   |

Each candidate receives: `proximityScore`, `intentScore`, `formScore`, `roleScore`, `directionScore`. Uses “hard form dominance” (e.g. submit in same form boosted, out-of-form penalized).

**Confidence:** `confidence = (topScore - secondScore) / topScore` (0–1).

**Output:** `PredictionResult { topThree: RankedPrediction[], confidence: number }`.

**AI fallback** (see §11) and **form filling**: `fillFormFields(formSelector, dataMap, options)` and `__fillActiveForm` (exposed on `window` for “Fill Form”). Privacy-conscious (no logging of field values in context).

---

## 11. AI Fallback Layer (`maybeUseAI`)

AI is used **only if**:

- Deterministic `confidence < 0.2`, **and**
- AI cooldown has passed.

**Safeguards:**

- Rate limiting.
- Semantic similarity matching of AI `predictedActionLabel` to `visibleActions`.
- AI confidence gate (>0.5).
- Similarity threshold (>0.5).
- Never overrides with low-confidence AI; fallback to deterministic if AI fails.

Flow: Convert `PageContext` → `CompactContext`; call `aiProvider.predictNextAction(compactContext)`; validate and match; merge into top three and recompute confidence.

---

## 12. Page Context Model

```ts
PageContext {
  pageIntent: string
  visibleActions: ActionCandidate[]
  forms: Form[]
  lastUserAction: UserAction | null
  lastActionRect: DOMRect | null
  viewport: { width, height }
}
```

**visibleActions** include: `label`, `selector` (cached via `dataset.flowSelector`), `role`, `boundingBox`, `formSelector`.

Note: `content.ts` builds a minimal inline `PageContext`; `contextBuilder.ts` can build a richer one (url, title, etc.). The prediction engine expects the minimal shape with `viewport` and `forms` as `Form[]`.

---

## 13. Autofill Assist

- **Trigger:** `focusin` on a form.
- **Condition:** Form must have ≥ 2 empty fields.
- **Excludes:** search forms, OTP fields, radio/checkbox.
- State stored in `activeFormForAutofill`; panel shows “Fill Form” button conditionally.
- Uses `safeSetValue` for React/Vue compatibility.

---

## 14. Agent Panel (`content/agent/agentPanel.ts`)

**Isolation:** Shadow DOM host element; styles via `adoptedStyleSheets`; all UI encapsulated; no global CSS pollution. Panel elements excluded from prediction via `[data-flow-recorder]`.

**API:** `initAgentPanel(executeCallback, recalculateCallback)` creates the panel; `renderAgentPanel(result, autofillAvailable, formFields)` updates UI; `setAIThinking(isThinking)` for AI indicator.

**UI features:** Live top-3 predictions, confidence %, animated progress bar, color-coded confidence, score badge per prediction, “Run” button, explainability toggle (score breakdown), hover highlight (outline restore via WeakMap), autofill assist UI, auto-execution flash indicator.

Autofill button calls `window.__fillActiveForm(generateSmartData(currentFormFields))` (placeholder data).

---

## 15. Performance Architecture

The system avoids unnecessary work via:

- Hover element tracking (`lastHoveredElement`).
- AI cooldown (e.g. 2s).
- Mutex guard (`isUpdating`).
- Prediction inertia threshold (`lastPrediction`).
- Selector caching (`dataset.flowSelector`).
- Debounce + throttle combo for updates.
- Shadow DOM isolation.

**Goal:** No prediction storms, no layout thrashing.

---

## 16. Advanced Features Implemented

- Provider-agnostic AI (Gemini / ChatGPT swappable).
- Deterministic-first architecture; AI fallback only when needed.
- Stable UI rendering (inertia, cooldowns).
- Form autofill support with safeSetValue.
- Prediction explainability (score breakdown).
- Hover-based spatial awareness.

The extension behaves as an **intelligent co-pilot** predicting next UI actions in real time — not a simple click recorder.

---

## 17. Next Potential Upgrades

- Move AI calls to background service worker (security / key isolation).
- Adaptive weight tuning via reinforcement learning.
- Intent drift detection.
- Runtime provider switching in the popup UI.
- Direct test file export (Cypress / Playwright).
- Multi-tab recording.
- Prediction heatmap overlay.
- Link preview heading prefetch.
- Smart AI form autofill inference.

---

## 18. Constraints

- Must remain Chrome Extension compatible.
- Must not degrade performance.
- Must maintain Shadow DOM isolation.
- Must not reinitialize panel unnecessarily.
- Must preserve provider abstraction.
- No global CSS injection.
- No blocking operations on main thread.

---

## 19. Development Goal

Evolve into a **production-ready intelligent web co-pilot**: stable and secure architecture, demo-level UX, extensible AI prediction framework.

---

## 20. Popup UI (React)

- **App.tsx**: Tabs “Control”, “Flow”, “AI”; listens to storage for `flowRecorder_events` and `flowRecorder_isRecording` to update event count and recording state.
- **RecorderControl**: Start/Stop/Clear recording; toggle agent on/off (sends `TOGGLE_AGENT` to content).
- **FlowViewer**: Displays and exports recorded events (e.g. JSON).
- **AIPanel**: Uses background `GENERATE_AI_SCRIPT` (currently mock), shows summary/prompts/metrics/test points, copy/export.

---

## 21. AI Provider Abstraction

- **Interface:** `AIProvider { predictNextAction(context: CompactContext): Promise<AIPrediction> }`.
- **Providers:** `GeminiProvider`, `ChatGPTProvider`.
- **Factory:** `createAIProvider(providerName, apiKey)` in `aiProviderFactory.ts`. Swappable without changing the prediction engine; adding a provider = implement interface + register in factory.
- **Config:** `config/aiConfig.ts` reads `VITE_GEMINI_API_KEY`, `VITE_OPENAI_API_KEY` (Vite `import.meta.env`). Security: keys are bundled at build time — not production-safe for public release; prefer user-supplied keys or a backend proxy.

---

## 22. Conventions & Gotchas

- **Two PageContext builders**: `content.ts` builds a minimal `PageContext` for the prediction engine (with `viewport`, simplified `forms`). `contextBuilder.ts` builds a fuller context (url, title, pageIntent inference, richer forms/actions). Do not mix them without adapting types; the engine expects the minimal shape.
- **Content script has no React**: Agent panel is vanilla DOM + Shadow DOM. Popup is React.
- **Selectors**: Prefer `selectorGenerator.generateCSSSelector` for recording; `contextBuilder` uses its own `generateStableSelector` (stable classes, escaping). Both aim for uniqueness and stability.
- **Privacy**: Context and form-fill logic avoid storing or logging input values; only “filled” vs “empty” and structure.
- **Cooldowns**: AI is rate-limited (e.g. 2s in content, 1s in predictionEngine) to avoid API spam and flicker.

---

## 23. How to Extend

- **New event type**: Add to `ACTION_TYPES` in `types/index.ts`; handle in `content.ts` capture and in `flowAnalyzer.ts` if needed.
- **New AI provider**: Implement `AIProvider` in `utils/<name>Provider.ts`; add to `aiProviderFactory.ts` and (if needed) to `aiConfig.ts` and `.env.example`.
- **New background action**: Add a `case` in `background.ts` and send from popup or content as appropriate.
- **New storage key**: Add to `STORAGE_KEYS` in `storage.ts` and use get/set helpers.

---

## 24. Files to Touch for Common Tasks

| Task                                        | Files                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Change recording behavior / what's captured | `content/content.ts`, `utils/elementAnalyzer.ts`                                               |
| Change prediction scoring                   | `utils/predictionEngine.ts`                                                                    |
| Change or add AI provider                   | `utils/aiProviderFactory.ts`, `utils/geminiProvider.ts` or `chatgptProvider.ts`, `types/ai.ts` |
| Change agent lifecycle / scheduling         | `content/agent/agentManager.ts`                                                                |
| Change agent UI                             | `content/agent/agentPanel.ts`, `ui/agentPanel.ts`                                              |
| Change prediction execution                 | `content/agent/execution.ts`, `utils/agentExecutor.ts`                                         |
| Change form detection / autofill            | `content/form/formDetect.ts`, `content/form/autofill.ts`                                       |
| Change AI rate limiting                     | `content/ai/rateLimit.ts`, `utils/aiQueue.ts`                                                  |
| Change popup UI                             | `src/popup/**`                                                                                 |
| Change flow analysis / AI export            | `utils/flowAnalyzer.ts`, `utils/aiFormatter.ts`                                                |
| Add message or storage                      | `background/background.ts`, `utils/storage.ts`                                                 |
| Manifest / permissions                      | `public/manifest.json`                                                                         |
| Build / entry points                        | `vite.config.ts`, `vite.config.content.ts`                                                     |

Use this context to make consistent, localized changes and to avoid breaking the contract between content script, background, and popup.
