/**
 * ChatGPT Tab Bridge
 * Runs on chatgpt.com — receives prompts from the extension,
 * types them into ChatGPT, waits for the response, and sends it back.
 */

const BRIDGE_ID = "__flowRecorderBridge__";

// Multiple selector fallbacks for ChatGPT UI variants
const INPUT_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][data-virtualkeyboard-disabled]",
  "div[contenteditable='true'].ProseMirror",
  "textarea[placeholder]",
  "[contenteditable='true']",
];
const SEND_BTN_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'form button[type="submit"]',
  "button:has(svg)[data-testid]",
];
const STOP_BTN_SELECTORS = [
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  '[data-testid="stop-button"]',
];
const RESPONSE_SELECTOR = '[data-message-author-role="assistant"]';

// Only initialise once per tab
if (!(window as any)[BRIDGE_ID]) {
  (window as any)[BRIDGE_ID] = true;
  console.log(
    "[FlowRecorder Bridge] ✅ ChatGPT bridge loaded on",
    window.location.href,
  );
}

/** Find first matching element from a list of selectors */
function findElement(selectors: string[]): Element | null {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

/** Wait for any of the given selectors to appear */
function waitForAny(selectors: string[], timeout = 10000): Promise<Element> {
  return new Promise((resolve, reject) => {
    const existing = findElement(selectors);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = findElement(selectors);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout: none of [${selectors.join(", ")}] found`));
    }, timeout);
  });
}

/**
 * Type text into the ChatGPT input using clipboard paste —
 * the most reliable method for React/ProseMirror controlled inputs.
 */
async function typeIntoInput(text: string): Promise<void> {
  const el = (await waitForAny(INPUT_SELECTORS)) as HTMLElement;
  console.log(
    "[FlowRecorder Bridge] Found input:",
    el.tagName,
    el.className.slice(0, 60),
  );

  el.focus();
  await new Promise((r) => setTimeout(r, 200));

  // Clear existing content
  el.innerHTML = "";
  el.textContent = "";

  // Use clipboard paste — works reliably with React-controlled contenteditable
  try {
    await navigator.clipboard.writeText(text);
    document.execCommand("paste");
    await new Promise((r) => setTimeout(r, 300));
    // If clipboard didn't work, fall back to execCommand insertText
    if (!el.textContent?.trim()) {
      document.execCommand("insertText", false, text);
    }
  } catch (_) {
    // Clipboard API blocked — fall back to execCommand + manual event
    document.execCommand("insertText", false, text);
  }

  // Fire React's synthetic input event via the native setter trick
  const nativeInputSetter =
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")?.set ||
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "textContent")?.set;
  if (nativeInputSetter && !el.textContent?.trim()) {
    nativeInputSetter.call(el, text);
  }

  // Dispatch events React listens to
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, cancelable: true, data: text }),
  );
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));

  console.log(
    "[FlowRecorder Bridge] Input content:",
    el.textContent?.slice(0, 80),
  );
}

/** Click the send button */
async function clickSend(): Promise<void> {
  // Wait a bit for the button to become enabled after input
  await new Promise((r) => setTimeout(r, 500));
  const btn = (await waitForAny(SEND_BTN_SELECTORS)) as HTMLButtonElement;
  console.log(
    "[FlowRecorder Bridge] Clicking send:",
    btn.getAttribute("aria-label") || btn.getAttribute("data-testid"),
  );
  btn.click();
}

/** Wait for the generation to complete and return the last assistant message text */
async function waitForResponse(
  prevCount: number,
  timeout = 60000,
): Promise<string> {
  const start = Date.now();

  // 1. Wait until a new assistant message appears
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const msgs = document.querySelectorAll(RESPONSE_SELECTOR);
      if (msgs.length > prevCount) return resolve();
      if (Date.now() - start > timeout)
        return reject(new Error("Timeout waiting for response to start"));
      setTimeout(check, 300);
    };
    check();
  });

  // 2. Wait until generation stops (stop button disappears)
  await new Promise<void>((resolve) => {
    const check = () => {
      const stopBtn = findElement(STOP_BTN_SELECTORS);
      if (!stopBtn) return resolve();
      if (Date.now() - start > timeout) return resolve();
      setTimeout(check, 500);
    };
    setTimeout(check, 1000); // give 1s for it to appear first
  });

  // 3. Also wait for content to stabilise (not changing for 1.5s)
  await new Promise<void>((resolve) => {
    let lastText = "";
    let stableFor = 0;
    const check = () => {
      const msgs = document.querySelectorAll(RESPONSE_SELECTOR);
      const last = msgs[msgs.length - 1]?.textContent || "";
      if (last === lastText) {
        stableFor += 500;
        if (stableFor >= 1500) return resolve();
      } else {
        lastText = last;
        stableFor = 0;
      }
      if (Date.now() - start > timeout) return resolve();
      setTimeout(check, 500);
    };
    check();
  });

  const msgs = document.querySelectorAll(RESPONSE_SELECTOR);
  return msgs[msgs.length - 1]?.textContent?.trim() || "";
}

/** Main handler for bridge requests */
chrome.runtime.onMessage.addListener((message, _sender) => {
  if (message.action !== "CHATGPT_BRIDGE_REQUEST") return false;

  const { prompt, requestId } = message;
  console.log(`[FlowRecorder Bridge] Received request ${requestId}`);

  // Fire-and-forget: do NOT use sendResponse (channel times out on long responses).
  // Send a brand-new message back to background when done so it can store the result.
  (async () => {
    try {
      const prevCount = document.querySelectorAll(RESPONSE_SELECTOR).length;
      await typeIntoInput(prompt);
      await clickSend();
      const response = await waitForResponse(prevCount);
      console.log(`[FlowRecorder Bridge] Response ready for ${requestId}`);
      chrome.runtime.sendMessage({
        action: "CHATGPT_BRIDGE_RESULT",
        requestId,
        success: true,
        response,
      });
    } catch (err) {
      console.error(`[FlowRecorder Bridge] Error:`, err);
      chrome.runtime.sendMessage({
        action: "CHATGPT_BRIDGE_RESULT",
        requestId,
        success: false,
        error: String(err),
      });
    }
  })();

  return false; // Not using sendResponse on this channel
});
