# AI Flow Recorder Chrome Extension — Gemini Handoff

## Project Overview
- **Purpose:** Chrome Extension (Manifest V3) to record user interaction flows (click/input/submit/route/fetch) for AI-powered test automation.
- **Frontend:** React (Vite, TypeScript, ES modules) for popup UI.
- **Architecture:**
  - **Content script:** Records events, shows overlay when recording, stores to `chrome.storage.local`.
  - **Background service worker:** Handles global commands, session management, AI preparation.
  - **Popup:** React UI for control, viewing flows, and AI panel.
  - **Utilities:** Selector generator, XPath, element analyzer, navigation detector, API interceptor, storage, flow analyzer, AI formatter.

## Current State
- **All code is TypeScript.**
- **Build:** Vite, outputs to `dist/`.
- **Manifest:** Manifest V3, content script is `content.js`, background is `background.js`, popup is `popup.html`.
- **Visual feedback:** Overlay appears when recording is active (should show on any page, but currently not visible — see below).
- **Recording state:** Persisted in `chrome.storage.local` as `flowRecorder_isRecording`.
- **Popup:** React, not yet converted to TSX.
- **Vite config:** Still JS, not yet TS.

## Outstanding Issues
- **Overlay not visible:**
  - `chrome.storage.local.get('flowRecorder_isRecording')` returns `true`, but overlay does not appear and no events are captured.
  - Likely cause: Content script is not injected or not running on the page. (Check Sources tab in DevTools, add a log at the top of content script, ensure extension is reloaded after build.)
- **Recording state:**
  - Is correctly persisted in storage, but content script may not be running or not reading it on reload.
- **Popup React:** Still in `.jsx`, needs conversion to `.tsx`.
- **Vite config:** Still in `.js`, can be converted to `.ts`.

## Debugging Steps (for Gemini)
1. **Check if content script is injected:**
   - Open DevTools on a target page, go to Sources tab, look for `content.js` under the extension.
   - If not present, content script is not running.
2. **Add debug log:**
   - At the top of `src/content/content.ts`, add: `console.log('[FlowRecorder] Content script loaded');`
   - Rebuild, reload extension, reload page, check Console.
3. **Check manifest:**
   - Ensure `content_scripts` in manifest points to `content.js` in `dist/`.
   - Ensure extension is reloaded after every build.
4. **Check overlay:**
   - In page console, run: `document.getElementById('__flow_recorder_overlay__')` (should return a DOM element if overlay is present).
5. **Check recording state:**
   - In page console, run: `chrome.storage.local.get('flowRecorder_isRecording', console.log)` (should be `true` if recording is active).

## Project Structure
- `src/`
  - `content/content.ts` — Content script (records events, shows overlay)
  - `background/background.ts` — Background service worker
  - `popup/` — React popup UI (App.jsx, main.jsx, components/)
  - `utils/` — All utility modules (TypeScript)
  - `types/` — TypeScript type definitions
- `public/manifest.json` — Manifest V3
- `vite.config.js` — Vite config (JS, not yet TS)
- `dist/` — Build output (content.js, background.js, popup.js, popup.html, manifest.json)

## Key Features
- **Event recording:** Click, input, submit, route change, API calls (fetch/XHR)
- **Visual feedback:** Red overlay when recording
- **Session management:** Session ID, event storage, session save/clear
- **AI preparation:** `prepareFlowForAI(flowData)` utility
- **SPA support:** Route change detection
- **Popup UI:** Start/stop recording, view flows, AI panel

## Next Steps for Gemini
- Debug why content script/overlay is not running (see steps above)
- Convert popup React files to TSX
- Convert vite.config.js to vite.config.ts (optional)
- Ensure all messaging and event recording works end-to-end
- Polish UI/UX as needed

---

**This file summarizes the current state, issues, and next steps for the AI Flow Recorder Chrome Extension project.**
