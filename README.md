# AI Flow Recorder — Chrome Extension

A **Manifest V3** Chrome Extension that does two things at once:

1. **Records** user interaction flows for AI-powered test-automation generation.
2. **Acts** as a live AI co-pilot — predicting your next UI action in real time using a deterministic scoring engine with an optional Gemini / ChatGPT fallback.

---

## Features

### 🎯 Flow Recording

- Captures **clicks**, **input changes**, **form submissions**, **route changes** (SPA-aware), and **API calls** (fetch/XHR).
- Every event includes:
  - Session ID, timestamp, URL, and route (pathname)
  - Full element metadata: tag, ID, className, innerText, name, type, role, aria-label, data-testid
  - Stable **CSS selector** and **XPath** fallback
  - API details: method, endpoint, status code, duration

### 🤖 Live AI Agent (Shadow DOM Panel)

- Floating panel injected via Shadow DOM — zero CSS pollution.
- Shows the **top-3 predicted next actions** with confidence score and per-factor score breakdown (proximity, intent, form, role, direction).
- Highlights the predicted element on hover.
- **"Run" button** to execute the predicted action directly.
- **"Fill Form" assist** — detects active forms and autofills fields with smart placeholder data.

### 🧠 Prediction Engine

- **Deterministic-first**: weighted scoring across five factors before any AI call.

  | Factor    | Weight |
  | --------- | ------ |
  | Proximity | 0.30   |
  | Intent    | 0.25   |
  | Form      | 0.25   |
  | Role      | 0.10   |
  | Direction | 0.10   |

- **Hard form dominance**: submit-type actions inside the active form are boosted ×1.25; out-of-form candidates penalised ×0.75.
- **AI fallback** (Gemini or ChatGPT) kicks in only when `confidence < 0.2` and the AI cooldown window has passed.
- AI results are validated by semantic similarity before overriding deterministic results.

### 📊 Flow Analysis & AI Export (Popup)

- **Flow tab**: browse recorded events, view selectors and API calls, export as JSON.
- **AI tab**: auto-generated summary, structured LLM prompt for test generation, metrics, and suggested test points.
- Export as JSON or Markdown.

---

## Tech Stack

| Layer      | Technology                                            |
| ---------- | ----------------------------------------------------- |
| Language   | TypeScript 5                                          |
| UI (popup) | React 18, CSS modules                                 |
| Build      | Vite 5 (two configs: popup/background + content)      |
| Extension  | Manifest V3, service worker, content script           |
| AI         | Gemini / ChatGPT via pluggable `AIProvider` interface |

---

## Project Structure

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
│   │   ├── agentPanel.ts           # Floating AI panel (Shadow DOM)
│   │   ├── agentManager.ts         # Agent lifecycle and prediction scheduling
│   │   ├── autofill.ts             # Form autofill assist
│   │   ├── chatgptBridge.ts        # Bridge script for ChatGPT tab provider
│   │   ├── execution.ts            # Execute predicted actions
│   │   ├── flyout.ts / flyout.css  # Flyout overlay UI
│   │   ├── formDetect.ts           # Active form detection
│   │   ├── prediction.ts           # Prediction wiring in content context
│   │   ├── providers.ts            # AI provider instantiation for content
│   │   ├── rateLimit.ts            # AI call rate limiting
│   │   └── state.ts                # Content-script shared state
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
├── vite.config.ts                  # Popup + background build
├── vite.config.content.ts          # Content script build (does not clear dist)
├── tsconfig.json
├── package.json
├── .env                            # API keys (never commit — see below)
└── dist/                           # Build output loaded by Chrome
```

---

## Setup & Installation

### Prerequisites

- Node.js 18+
- npm
- Chrome, Edge, or Brave (Chromium-based)

### 1. Install dependencies

```bash
cd chrome-extension-flow-recorder
npm install
```

### 2. Configure API keys (optional)

Create a `.env` file in the project root. These are build-time keys injected by Vite — **never commit this file**.

```env
VITE_GEMINI_API_KEY=your_gemini_api_key
VITE_OPENAI_API_KEY=your_openai_api_key
```

The Gemini key is used first; ChatGPT is the fallback. If neither key is set, the extension uses deterministic predictions only.

### 3. Build

```bash
npm run build
```

This runs two Vite builds:

- **`vite build`** — popup (`popup.html`, `popup.js`) and background service worker (`background.js`).
- **`vite build --config vite.config.content.ts`** — content script (`content.js`) and ChatGPT bridge (`chatgptBridge.js`).

Output lands in `dist/`.

### 4. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

## Development

```bash
# Watch mode: rebuilds popup/background + content script on change
npm run dev

# Type-check
npm run check
```

---

## Usage

### Recording a Flow

1. Click the extension icon to open the popup.
2. **Control tab** → click **Start**.
3. Interact with any web page.
4. Click **Stop** when done.
5. **Flow tab** — browse events, view selectors, or **Export JSON**.

### AI Analysis

1. **AI tab** → view auto-generated summary, LLM prompt, metrics, and test point suggestions.
2. Copy the structured prompt to clipboard or export as Markdown for use with any LLM.

### Live Agent Panel

The floating panel appears automatically on every page once the extension is loaded. It:

- Displays top-3 predicted next actions with confidence and score breakdown.
- Lets you **Run** a prediction or **Fill Form** when a form is active.
- Can be toggled from the **Control tab** in the popup.

---

## Architecture Overview

### Message Protocol

The background service worker brokers all communication:

| Action            | Sender  | Effect                                       |
| ----------------- | ------- | -------------------------------------------- |
| `START_RECORDING` | Popup   | Persists state; broadcasts to all tabs       |
| `STOP_RECORDING`  | Popup   | Persists state; broadcasts to all tabs       |
| `GET_EVENTS`      | Popup   | Returns stored events                        |
| `CLEAR_EVENTS`    | Popup   | Clears events from storage                   |
| `SAVE_SESSION`    | Popup   | Appends current events as a saved session    |
| `TOGGLE_AGENT`    | Popup   | Enables/disables the agent panel on all tabs |
| `EVENT_RECORDED`  | Content | Keeps service worker alive                   |

### Storage Keys

All stored in `chrome.storage.local`:

| Key                           | Value                          |
| ----------------------------- | ------------------------------ |
| `flowRecorder_events`         | Array of `RecordedEvent`       |
| `flowRecorder_sessionId`      | Current session ID             |
| `flowRecorder_isRecording`    | Boolean                        |
| `flowRecorder_sessions`       | Saved sessions                 |
| `flowRecorder_lastUserAction` | Last event (for agent context) |
| `flowRecorder_agentEnabled`   | Whether the agent panel is on  |

### Prediction Pipeline

```
mousemove / interaction event
        ↓
  buildPageContext()
        ↓
  generatePredictions(context)   ← deterministic weighted scoring
        ↓
  confidence < 0.2 AND cooldown passed?
        ↓ yes
  maybeUseAI(context)            ← Gemini / ChatGPT
        ↓
  renderAgentPanel(topThree, confidence)
```

---

## Security & Privacy

- **Local-only storage** — no data leaves the browser unless you paste an exported prompt into an external LLM.
- API keys are embedded at build time via Vite's `import.meta.env`; they exist only in the extension bundle.
- The agent panel is isolated in Shadow DOM; it cannot be styled or read by the host page.
- Elements marked `[data-flow-recorder]` are excluded from recording and prediction.

---

## Limitations

- Recordings are scoped to the active tab (no cross-tab recording).
- API keys are bundled into the extension — for personal/dev use only. Avoid publishing to the Chrome Web Store with live API keys.
- AI fallback requires a network connection and a valid API key.

---

## Potential Upgrades

- Move AI calls to the background service worker for better key isolation.
- Adaptive weight tuning via reinforcement learning.
- Intent drift detection.
- Runtime provider switching in the popup UI.
- Direct test file export (Cypress / Playwright).
- Multi-tab recording.
- Prediction heatmap overlay.

---

**Built with TypeScript, React 18, Vite 5, and Chrome Manifest V3**
