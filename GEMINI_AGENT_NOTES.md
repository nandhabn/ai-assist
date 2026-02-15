# Gemini Agent Notes: AI Flow Recorder Chrome Extension

This file contains essential details about the project for the Gemini agent.

## Project Overview

- **Purpose:** A Chrome Extension (Manifest V3) designed to record user interaction flows (clicks, inputs, submissions, route changes, and fetch requests) for use in AI-powered test automation.
- **Frontend:** The popup UI is built with React, using Vite for bundling and development. The project is written in TypeScript.

## Project Structure & Key Files

- **`src/`**: Main source code directory.
  - **`content/content.ts`**: The content script responsible for recording user events and displaying a visual overlay during recording.
  - **`background/background.ts`**: The background service worker that manages global commands, session state, and prepares data for AI processing.
  - **`popup/`**: Contains the React-based popup UI, including components for controlling recording, viewing flows, and an AI panel.
  - **`utils/`**: A collection of utility modules for various tasks like selector generation, element analysis, and API interception.
  - **`types/`**: Holds TypeScript type definitions.
- **`public/manifest.json`**: The Chrome Extension's Manifest V3 file.
- **`vite.config.js`**: The configuration file for the Vite build tool.
- **`dist/`**: The output directory for the built extension files.
- **`package.json`**: Defines project scripts and dependencies.

## Development

- **Build:** To build the extension, run `npm run build`.
- **Development:** To run the development server, use `npm run dev`.

## Known Issues & Debugging

- **Content Script/Overlay Not Visible:** The primary issue is that the content script does not seem to be running on pages, which means the recording overlay is not visible and no events are being captured.
  - **Debugging Steps:**
    1. Verify `content.js` is injected by checking the Sources tab in Chrome DevTools.
    2. Add `console.log` statements to `content.ts` to confirm it's loaded.
    3. Ensure the extension is reloaded in Chrome after each build.
    4. Check that `content_scripts` in `manifest.json` is correctly configured.
- **Popup UI:** The React components in the `popup` directory are still in `.jsx` format and should be converted to `.tsx`.
- **Vite Config:** The `vite.config.js` can be updated to `vite.config.ts`.
