# AI Flow Recorder - Chrome Extension

A production-grade Chrome Extension (Manifest V3) that records user interaction flows for AI-powered test automation generation.

## Features

### 🎯 Core Recording Capabilities

- **Click Events**: Tracks all user clicks with element metadata
- **Input Changes**: Records form field interactions
- **Form Submissions**: Captures form data and submission events
- **Route Detection**: Identifies SPA navigation changes
- **API Interception**: Monitors fetch and XHR calls with response status

### 📊 Event Tracking

Each recorded event includes:

- Session ID & timestamp
- Current URL and route (pathname)
- Action type (click, input, submit, api_call, route_change)
- Complete element metadata:
  - Tag, ID, className, text content
  - name, type, role, aria-label, data-testid
- Reliable CSS selector
- XPath fallback
- API details (method, endpoint, status, duration)

### 🧠 AI Intelligence Layer

- **Flow Analysis**: Groups events into logical flows with graph structure
- **Form Detection**: Identifies and maps form fields
- **API Tracking**: Extracts endpoints and call patterns
- **Test Point Identification**: Suggests testing scenarios

### 🤖 AI Preparation

Converts recorded flows into:

- **Structured Prompts**: LLM-ready test generation prompts
- **User Journey Summaries**: High-level flow descriptions
- **Test Recommendations**: Validation, edge cases, error scenarios
- **Export Formats**: JSON, Markdown, and structured data

## Installation

### Prerequisites

- Node.js 16+
- npm or yarn
- Chrome/Chromium browser

### Setup

```bash
# Clone or create project
cd chrome-extension-flow-recorder

# Install dependencies
npm install

# Build extension
npm run build

# Load in Chrome
# 1. Open chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the dist/ folder
```

## Development

```bash
# Watch mode for development
npm run dev

# Production build
npm run build

# Preview build output
npm run preview
```

## Project Structure

```
src/
├── background/
│   └── background.js          # Service worker for background tasks
├── content/
│   └── content.js             # Content script for DOM interaction tracking
├── popup/
│   ├── components/
│   │   ├── RecorderControl.jsx    # Start/Stop/Clear controls
│   │   ├── FlowViewer.jsx         # View recorded events
│   │   └── AIPanel.jsx            # AI analysis panel
│   ├── styles/                    # Component-specific CSS
│   ├── App.jsx                    # Main popup app
│   ├── main.jsx                   # React entry point
│   └── popup.html                 # Popup HTML
├── utils/
│   ├── storage.js             # Chrome storage API wrapper
│   ├── selectorGenerator.js   # CSS & XPath selector generation
│   ├── elementAnalyzer.js     # DOM element metadata extraction
│   ├── navigationDetector.js  # SPA route change detection
│   ├── apiInterceptor.js      # Fetch & XHR interception
│   ├── flowAnalyzer.js        # Event flow analysis & structuring
│   └── aiFormatter.js         # AI prompt formatting & export
├── types/
│   └── index.js               # JSDoc type definitions
└── public/
    └── manifest.json          # Manifest V3 configuration

vite.config.js                # Vite build configuration
package.json                  # Project dependencies
```

## Usage

### Recording Flows

1. **Open Popup**: Click extension icon in Chrome toolbar
2. **Start Recording**: Click "Start" button
3. **Perform Actions**: Interact with the web application
4. **Stop Recording**: Click "Stop" button

### Viewing Recorded Events

1. Click "Flow" tab in popup
2. Browse recorded events with expandable details
3. View selectors, element metadata, and API calls
4. Export as JSON

### Analyzing with AI

1. Click "AI" tab in popup
2. View automatic flow analysis:
   - **Summary**: Pages, actions, APIs at a glance
   - **LLM Prompt**: Structured prompt for test generation
   - **Metrics**: Detailed statistics
   - **Test Points**: Suggested test scenarios
3. Copy prompt to clipboard or export as markdown

## Architecture

### Manifest V3 Compliance

- ✅ Service worker (not background page)
- ✅ Content script for DOM access
- ✅ chrome.storage API for data persistence
- ✅ No deprecated APIs
- ✅ ES Modules throughout

### Security & Privacy

- Local-only storage (no backend)
- No external API calls
- User-controlled recording
- Clear button to delete data
- Session-based isolation

### Performance

- Efficient event deduplication
- Minimal DOM traversal
- Optimized storage operations
- Lazy-loaded UI components

## Configuration

### Modifying Recording Behavior

**src/content/content.js**:

```javascript
// Change tracked elements in shouldTrackElement()
function shouldTrackElement(element) {
  // Customize logic here
}
```

**src/utils/navigationDetector.js**:

```javascript
// Adjust SPA detection sensitivity
export function isDifferentPage(url1, url2) {
  // Customize page transition detection
}
```

## API Reference

### Storage API

```javascript
import * as storage from "@/utils/storage.js";

await storage.saveEvent(event);
const events = await storage.getEvents();
await storage.clearEvents();
```

### Flow Analysis

```javascript
import { analyzeEventFlow } from "@/utils/flowAnalyzer.js";

const flow = analyzeEventFlow(events);
// Returns: { nodes, edges, stats }
```

### AI Formatting

```javascript
import { prepareFlowForAI } from "@/utils/aiFormatter.js";

const aiData = prepareFlowForAI(flowData);
// Returns: { summary, structuredPrompt, metadata, ... }
```

### Selector Generation

```javascript
import {
  generateCSSSelector,
  generateXPath,
} from "@/utils/selectorGenerator.js";

const cssSelector = generateCSSSelector(element);
const xpathSelector = generateXPath(element);
```

## Output Examples

### Recorded Event

```json
{
  "sessionId": "session_1707043200000_abc123",
  "timestamp": 1707043200000,
  "url": "https://example.com/login",
  "route": "/login",
  "actionType": "click",
  "elementMetadata": {
    "tag": "button",
    "id": "submit-btn",
    "className": "btn btn-primary",
    "innerText": "Sign In",
    "ariaLabel": "Submit login form"
  },
  "selector": {
    "css": "#submit-btn",
    "xpath": "/html/body/div/form/button[1]"
  }
}
```

### AI Prepared Flow

```json
{
  "summary": "## User Journey Summary\n- Pages visited: 3\n- User actions: 8\n- API calls: 2",
  "structuredPrompt": "# AI Test Generation Context\n\n## User Flow\nThe user performed...",
  "metadata": {
    "sessionId": "session_123",
    "duration": 45000,
    "pageCount": 3,
    "actionCount": 8,
    "apiCallCount": 2
  },
  "flowGraph": {
    "nodes": [...],
    "edges": [...]
  }
}
```

## Supported Test Scenarios

The AI panel automatically suggests tests for:

- ✅ Form validation (empty fields, formats, edge cases)
- ✅ API endpoints (normal flow, errors, timeouts)
- ✅ Navigation flows (page transitions, state persistence)
- ✅ Authentication (login, logout, session expiration)
- ✅ User input (special characters, boundary values)

## Browser Compatibility

- ✅ Chrome 90+
- ✅ Edge 90+ (Chromium-based)
- ✅ Brave
- ✅ Opera

## Limitations

- Records flows on the current tab only
- No backend integration (local storage only)
- Limited to web applications (not native apps)
- Respects CSP restrictions on some sites

## Future Enhancements

- [ ] Multi-tab recording
- [ ] Cloud sync & collaboration
- [ ] Custom event filters
- [ ] Visual flow diagram rendering
- [ ] Direct test file generation (Cypress, Playwright)
- [ ] Performance metrics tracking
- [ ] Network throttling simulation

## Troubleshooting

### Events Not Recorded

1. Ensure extension is enabled in chrome://extensions/
2. Check recording status (red badge indicates recording)
3. Clear extension data and try again

### Selectors Not Working

1. CSS selectors are prioritized; XPath used as fallback
2. Dynamic elements may require custom selector logic
3. Check browser console for errors

### AI Analysis Missing

1. Requires at least 5-10 events recorded
2. Check event types are diverse (not just clicks)
3. Ensure URLs contain meaningful paths

## Development Notes

### Adding New Event Types

1. Add to `ACTION_TYPES` in `src/types/index.js`
2. Implement listener in `src/content/content.js`
3. Update analyzer in `src/utils/flowAnalyzer.js`

### Extending AI Analysis

1. Modify `prepareFlowForAI()` in `src/utils/aiFormatter.js`
2. Update AI panel component `src/popup/components/AIPanel.jsx`
3. Test with sample flows

## License

MIT

## Support

For issues, feature requests, or contributions, please use GitHub issues.

---

**Built with React, Vite, and Chrome Manifest V3** 🚀
