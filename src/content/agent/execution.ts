/**
 * DOM execution helpers for the agent.
 * All functions are purely DOM-driven — no shared state dependency.
 */

import type { AgentToolCall } from "@/types/ai";
import type { RankedPrediction } from "@/utils/predictionEngine";

// ─── On-screen agent message toast ───────────────────────────────────────────

const TOAST_ID = "flow-recorder-agent-toast";

/**
 * Displays a toast banner on the page with the agent's message.
 * Automatically dismisses after `durationMs` milliseconds.
 * Calling it again while a toast is visible replaces the message.
 */
export function showAgentMessage(
  message: string,
  type: "info" | "success" | "error" = "info",
  durationMs = 6000,
): void {
  let toast = document.getElementById(TOAST_ID) as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    // Namespace all styles inline so they're unaffected by the host page's CSS.
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      maxWidth: "380px",
      padding: "14px 18px",
      borderRadius: "10px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      transition: "opacity 0.3s ease",
      opacity: "0",
    } as Partial<CSSStyleDeclaration>);
    toast.dataset.flowRecorder = "true";
    document.body.appendChild(toast);
  }

  // Make the toast interactive so the close button is clickable
  toast.style.pointerEvents = "auto";

  const colors: Record<typeof type, { bg: string; border: string; icon: string }> = {
    info:    { bg: "#1e293b", border: "#334155", icon: "ℹ️" },
    success: { bg: "#14532d", border: "#166534", icon: "✅" },
    error:   { bg: "#450a0a", border: "#7f1d1d", icon: "❌" },
  };
  const c = colors[type];
  Object.assign(toast.style, {
    background: c.bg,
    border: `1px solid ${c.border}`,
    color: "#f1f5f9",
  } as Partial<CSSStyleDeclaration>);
  toast.innerHTML =
    `<span style="font-size:18px;flex-shrink:0">${c.icon}</span>` +
    `<span style="flex:1">${message}</span>` +
    `<button id="${TOAST_ID}-close" style="background:none;border:none;color:#94a3b8;` +
      `font-size:16px;cursor:pointer;padding:0 0 0 8px;line-height:1;flex-shrink:0;` +
      `margin-top:-2px" title="Dismiss">\u2715</button>`;

  // Fade in
  requestAnimationFrame(() => {
    toast!.style.opacity = "1";
  });

  // Auto-dismiss
  const dismiss = () => {
    toast!.style.opacity = "0";
    setTimeout(() => toast?.remove(), 400);
  };
  clearTimeout((toast as any)._dismissTimer);
  (toast as any)._dismissTimer = setTimeout(dismiss, durationMs);

  // Close button click
  document.getElementById(`${TOAST_ID}-close`)?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearTimeout((toast as any)._dismissTimer);
    dismiss();
  });
}

// ─── Element finders ─────────────────────────────────────────────────────────

/** Computes a relevance score to rank duplicate-label candidates. Higher = better. */
function scoreElement(el: HTMLElement): number {
  let score = 0;
  const rect = el.getBoundingClientRect();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  // Fully inside viewport
  if (rect.top >= 0 && rect.bottom <= vpH && rect.left >= 0 && rect.right <= vpW) score += 10;
  // Partially visible in viewport
  else if (rect.top < vpH && rect.bottom > 0 && rect.left < vpW && rect.right > 0) score += 5;

  // Larger area = more prominent (capped so giant containers don't dominate)
  const area = rect.width * rect.height;
  if (area > 20) score += Math.min(4, Math.floor(area / 2000));

  // Not hidden from assistive tech
  if (
    el.getAttribute("aria-hidden") !== "true" &&
    el.closest('[aria-hidden="true"]') === null
  ) score += 3;

  // Semantic interactive elements rank higher than generic divs with tabindex
  const tag = el.tagName.toLowerCase();
  if (["button", "a", "input", "select", "textarea"].includes(tag)) score += 2;
  const role = el.getAttribute("role");
  if (role && ["button", "link", "menuitem", "tab", "option"].includes(role)) score += 2;

  // Enabled beats disabled
  if (!(el as HTMLButtonElement).disabled) score += 1;

  // Higher stacking context (z-index) = more likely to be the focused/active layer.
  // Walk up the DOM and take the maximum effective z-index found on any ancestor.
  let maxZ = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.documentElement) {
    const z = parseInt(window.getComputedStyle(cur).zIndex ?? "auto", 10);
    if (!isNaN(z) && z > maxZ) maxZ = z;
    cur = cur.parentElement;
  }
  // Map z-index to bonus points (capped so it doesn't overwhelm other signals)
  if (maxZ > 0) score += Math.min(8, Math.floor(Math.log10(maxZ + 1) * 3));

  // Modal/dialog awareness — when a dialog overlay is open, elements inside it
  // are almost always the intended target; elements outside are visually blocked.
  const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="alertdialog"]';
  if (el.closest(MODAL_SELECTOR)) {
    // Inside a modal: strong boost so the dialog's buttons always win.
    score += 12;
  } else if (document.querySelector(MODAL_SELECTOR)) {
    // Outside a modal while one is open: penalise to avoid accidentally
    // clicking nav/sidebar elements that are hidden behind the overlay.
    score -= 8;
  }

  return score;
}

/** Returns a short CSS-path string for an element (used in disambiguation graph). */
function buildDomPath(el: HTMLElement, depth = 4): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  for (let i = 0; i < depth && cur && cur !== document.body; i++) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? `#${cur.id}` : "";
    const testid = cur.getAttribute("data-testid")
      ? `[data-testid="${cur.getAttribute("data-testid")}"]`
      : "";
    const roleAttr =
      !id && !testid && cur.getAttribute("role")
        ? `[role="${cur.getAttribute("role")}"]`
        : "";
    parts.unshift(`${tag}${id}${testid}${roleAttr}`);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/**
 * Base attribute extractor shared by all label-matchers.
 * Checks aria-label, data-testid, title, placeholder, then textContent.
 */
function elementLabelText(el: HTMLElement): string {
  return (
    el.getAttribute("aria-label") ??
    el.getAttribute("data-testid") ??
    el.getAttribute("title") ??
    el.getAttribute("placeholder") ??
    el.textContent ??
    ""
  )
    .toLowerCase()
    .trim();
}

export interface LabelCandidate {
  el: HTMLElement;
  score: number;
  domPath: string;
}

/**
 * Returns ALL visible interactive elements that match `label`, sorted by
 * relevance score descending. Call this when you need the full candidate list.
 */
export function findAllElementsByLabel(label: string): LabelCandidate[] {
  const needle = label.toLowerCase().trim();
  const selectors = [
    "button", "a", "input:not([type=hidden])", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="option"]', "[tabindex]",
  ].join(",");

  const visible = Array.from(document.querySelectorAll<HTMLElement>(selectors)).filter((el) => {
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && (el.offsetWidth > 0 || el.offsetHeight > 0);
  });

  const seen = new Set<HTMLElement>();
  const matched: HTMLElement[] = [];

  // Three precision tiers: exact → starts-with → contains
  for (const tier of [
    (t: string) => t === needle,
    (t: string) => t.startsWith(needle),
    (t: string) => t.includes(needle),
  ]) {
    for (const el of visible) {
      if (!seen.has(el) && tier(elementLabelText(el))) {
        seen.add(el);
        matched.push(el);
      }
    }
  }

  return matched
    .map((el) => ({ el, score: scoreElement(el), domPath: buildDomPath(el) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Builds a human-readable disambiguation graph for AI error feedback.
 * Lists all candidates with their DOM path, score, and position.
 *
 * Example output:
 *   3 elements match "Post":
 *   [1] score=18  main > div[data-testid="toolBar"] > button  pos=(1200,40)
 *   [2] score=8   nav > a[href="/compose"]                    pos=(30,400)
 *   [3] score=3   footer > div > span                         pos=(600,900)
 */
export function buildDisambiguationGraph(label: string, candidates: LabelCandidate[]): string {
  const lines = [`${candidates.length} elements match "${label}":`];
  for (let i = 0; i < candidates.length; i++) {
    const { el, score, domPath } = candidates[i];
    const rect = el.getBoundingClientRect();
    const snippet = (el.textContent ?? "").trim().slice(0, 40).replace(/\s+/g, " ");
    lines.push(
      `  [${i + 1}] score=${score}  ${domPath}  pos=(${Math.round(rect.left)},${Math.round(rect.top)})` +
        (snippet ? `  text="${snippet}"` : ""),
    );
  }
  lines.push('To target a specific one, refine the label (e.g. add the data-testid value or parent context).');
  return lines.join("\n");
}

/**
 * Finds the best-matching interactive element for a label.
 * When multiple elements share the same label, the highest-scored candidate
 * (viewport position, visibility, semantics) is returned automatically.
 * All candidates are logged to the console for inspection.
 */
export function findElementByLabel(label: string): HTMLElement | null {
  const candidates = findAllElementsByLabel(label);
  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    console.log(`[Agent] "${label}" matched ${candidates.length} elements — using top-scored:`);
    candidates.forEach(({ score, domPath }, i) =>
      console.log(`  [${i + 1}] score=${score}  ${domPath}`),
    );
  }

  return candidates[0].el;
}

/**
 * Finds the best matching <a> element and returns its resolved href, or null.
 * Matching priority: exact text → starts-with → includes → aria-label/title.
 */
export function findNavHrefByLabel(label: string): string | null {
  const needle = label.toLowerCase().trim();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const valid = anchors.filter((a) => {
    const h = a.getAttribute("href") ?? "";
    return h && !h.startsWith("#") && !h.startsWith("javascript:");
  });

  const exact = valid.find((a) => (a.textContent ?? "").toLowerCase().trim() === needle);
  if (exact) return exact.href;
  const starts = valid.find((a) => (a.textContent ?? "").toLowerCase().trim().startsWith(needle));
  if (starts) return starts.href;
  const includes = valid.find((a) => (a.textContent ?? "").toLowerCase().includes(needle));
  if (includes) return includes.href;

  const attrMatch = valid.find((a) =>
    [
      (a.getAttribute("aria-label") ?? "").toLowerCase(),
      (a.getAttribute("title") ?? "").toLowerCase(),
    ].some((v) => v === needle || v.includes(needle)),
  );
  return attrMatch ? attrMatch.href : null;
}

/**
 * Extracts a navigation URL from an AI prediction label or a plan step text.
 * Handles patterns like "Navigate to https://...", "Go to https://...", bare URLs.
 */
export function extractNavigationUrl(
  label: string,
  plan?: string,
  currentPlanStep?: number,
): string | null {
  const urlRe = /https?:\/\/[^\s"'>)]+/;

  const labelMatch = label.match(urlRe);
  if (labelMatch) return labelMatch[0];

  const lcLabel = label.toLowerCase();
  const isNavIntent =
    lcLabel.startsWith("navigate") ||
    lcLabel.startsWith("go to") ||
    lcLabel.startsWith("open") ||
    lcLabel.startsWith("visit") ||
    lcLabel.includes("navigate to");

  if (isNavIntent && plan && currentPlanStep != null) {
    const lines = plan.split("\n");
    const stepPatterns = [
      new RegExp(`^\\s*${currentPlanStep}[.):]?\\s`, "i"),
      new RegExp(`step\\s*${currentPlanStep}[.):]?\\s`, "i"),
    ];
    for (const line of lines) {
      if (stepPatterns.some((re) => re.test(line))) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
    for (const line of lines) {
      if (/navigate|go to|open|visit/i.test(line)) {
        const m = line.match(urlRe);
        if (m) return m[0];
      }
    }
  }

  return null;
}

// ─── Tool-call execution ──────────────────────────────────────────────────────

export interface ExecuteResult {
  success: boolean;
  failureReason?: string;
}

/**
 * Executes a structured AgentToolCall (navigate / click / type / scroll / message / done).
 * Returns { success, failureReason? } so callers can feed the error back to the AI.
 */
export async function executeAgentToolCall(toolCall: AgentToolCall): Promise<ExecuteResult> {
  const { tool, params } = toolCall;
  console.log(`[Agent Tool] ${tool}`, params);

  // ── Skill tool: run the pre-resolved step sequence ────────────────────────
  if (toolCall.skillSteps && toolCall.skillSteps.length > 0) {
    console.log(`[Agent Tool] Running skill tool "${tool}" (${toolCall.skillSteps.length} steps)`);
    for (const step of toolCall.skillSteps) {
      const stepCall: AgentToolCall = {
        tool: step.tool,
        params: {
          label:     step.label,
          text:      step.text,
          url:       step.url,
          direction: step.direction,
          message:   step.message,
          ms:        step.ms,
        },
        reasoning: `skill step: ${step.tool}`,
        confidenceEstimate: 1,
      };
      const result = await executeAgentToolCall(stepCall);
      if (!result.success) return result; // abort sequence on first failure
      // Small pause between steps so the page can react
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    return { success: true };
  }

  switch (tool) {
    case "navigate": {
      if (!params.url) {
        return { success: false, failureReason: "navigate tool called without a URL" };
      }
      window.location.href = params.url;
      return { success: true };
    }

    case "click": {
      const label = params.label ?? "";
      const candidates = findAllElementsByLabel(label);

      if (candidates.length > 0) {
        const el = candidates[0].el;
        if (candidates.length > 1) {
          console.log(`[Agent Tool] click: multiple matches for "${label}" — ${buildDisambiguationGraph(label, candidates)}`);
        }
        el.scrollIntoView({ behavior: "instant", block: "center" });
        await new Promise<void>((r) => setTimeout(r, 80));
        // Prevent new-tab navigation: patch the anchor (or the nearest ancestor anchor)
        // so target="_blank" links stay in the current tab.
        const anchor =
          el instanceof HTMLAnchorElement ? el : el.closest<HTMLAnchorElement>("a[href]");
        if (anchor && anchor.href && anchor.target && anchor.target !== "_self") {
          anchor.target = "_self";
          anchor.rel = "noreferrer";
        }
        el.click();
        return { success: true };
      }
      const href = findNavHrefByLabel(label);
      if (href) {
        console.log(`[Agent Tool] click fallback via href: ${href}`);
        window.location.href = href;
        return { success: true };
      }
      const reason = `No element found matching label "${label}" — it may be inside a panel, hidden, or use a different label`;
      console.warn(`[Agent Tool] click: ${reason}`);
      return { success: false, failureReason: reason };
    }

    case "type": {
      const label = params.label ?? "";
      const text = params.text ?? "";

      // Helper: type text into a contenteditable element letter-by-letter,
      // dispatching keydown → keypress → input (insertText) → keyup per character
      // so React/framework state machines (like X's tweet composer) register every keystroke.
      const typeIntoContentEditable = async (el: HTMLElement) => {
        el.focus();
        // Clear existing content via select-all + delete
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
        await new Promise<void>((r) => setTimeout(r, 30));

        for (const char of Array.from(text)) {
          const keyOpts: KeyboardEventInit = {
            key: char, code: `Key${char.toUpperCase()}`,
            keyCode: char.charCodeAt(0), which: char.charCodeAt(0),
            bubbles: true, cancelable: true,
          };
          el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
          el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
          // Insert the character at the current caret position
          document.execCommand("insertText", false, char);
          el.dispatchEvent(new InputEvent("input", {
            bubbles: true, cancelable: true,
            inputType: "insertText", data: char,
          }));
          el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
          // Small delay between characters so the site sees them as real typing
          await new Promise<void>((r) => setTimeout(r, 20));
        }
      };

      // Helper: type into a standard input/textarea
      const typeIntoInput = (el: HTMLInputElement | HTMLTextAreaElement) => {
        const tag = el.tagName.toLowerCase();
        const proto = tag === "textarea"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSetter) nativeSetter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      // When no label is provided, type into whatever is currently focused.
      if (!label.trim()) {
        const active = document.activeElement as HTMLElement | null;
        if (active) {
          const tag = active.tagName.toLowerCase();
          if (tag === "input" || tag === "textarea") {
            typeIntoInput(active as HTMLInputElement | HTMLTextAreaElement);
            return { success: true };
          }
          if (active.isContentEditable) {
            await typeIntoContentEditable(active);
            return { success: true };
          }
        }
        // No focused typeable element — fall through to label-based search below
      }

      // Search among standard input/textarea elements first.
      const typeableSelectors = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea";
      const typeableAll = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(typeableSelectors),
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && el.offsetWidth > 0;
      });

      const typeableText = (el: HTMLElement) =>
        [
          el.getAttribute("aria-label"),
          el.getAttribute("data-testid"),
          el.getAttribute("placeholder"),
          el.getAttribute("title"),
          el.getAttribute("name"),
          (() => {
            if (!el.id) return null;
            return document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? null;
          })(),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .trim();

      const needle = label.toLowerCase().trim();

      // Collect all matching inputs, score them, pick the best
      const matchedInputs = typeableAll.filter((e) => {
        const t = typeableText(e);
        return t === needle || t.includes(needle) || (needle && needle.includes(t) && t.length > 2);
      });
      if (matchedInputs.length > 1) {
        console.log(`[Agent Tool] type: ${matchedInputs.length} inputs match "${label}" — using highest-scored`);
        matchedInputs.forEach((e, i) => console.log(`  [${i + 1}] ${buildDomPath(e)} score=${scoreElement(e)}`));
      }
      let inputEl: HTMLInputElement | HTMLTextAreaElement | null =
        matchedInputs.sort((a, b) => scoreElement(b) - scoreElement(a))[0] ?? null;

      if (!inputEl) {
        const broad = findElementByLabel(label);
        if (broad && (broad.tagName.toLowerCase() === "input" || broad.tagName.toLowerCase() === "textarea")) {
          inputEl = broad as HTMLInputElement | HTMLTextAreaElement;
        }
      }

      if (inputEl) {
        inputEl.scrollIntoView({ behavior: "instant", block: "center" });
        inputEl.focus();
        await new Promise<void>((r) => setTimeout(r, 150));
        typeIntoInput(inputEl);
        await new Promise<void>((r) => setTimeout(r, 300));
        return { success: true };
      }

      // No standard input found — search for a visible contenteditable element.
      const contentEditables = Array.from(
        document.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='']"),
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && el.offsetWidth > 0;
      });

      // Score and pick best contenteditable candidate
      const matchedCEs = needle
        ? contentEditables.filter((e) => {
            const t = typeableText(e);
            return t === needle || t.includes(needle);
          })
        : [];

      // Sort all ceEls by score so we pick the most prominent one on fallback
      const sortedCEs = contentEditables
        .map((e) => ({ e, score: scoreElement(e) }))
        .sort((a, b) => b.score - a.score);

      let ceEl: HTMLElement | null = null;
      if (matchedCEs.length > 0) {
        if (matchedCEs.length > 1) {
          console.log(`[Agent Tool] type: ${matchedCEs.length} contenteditable elements match "${label}" — using highest-scored`);
          matchedCEs.forEach((e, i) => console.log(`  [${i + 1}] ${buildDomPath(e)} score=${scoreElement(e)}`));
        }
        ceEl = matchedCEs.sort((a, b) => scoreElement(b) - scoreElement(a))[0];
      } else if (sortedCEs.length > 0) {
        // Fallback: use the most visible/prominent contenteditable
        ceEl = sortedCEs[0].e;
      }

      if (ceEl) {
        ceEl.scrollIntoView({ behavior: "instant", block: "center" });
        ceEl.focus();
        await new Promise<void>((r) => setTimeout(r, 150));
        await typeIntoContentEditable(ceEl);
        await new Promise<void>((r) => setTimeout(r, 300));
        return { success: true };
      }

      // Build a disambiguation graph for any elements that broadly matched, to help the AI retry
      const allCandidates = findAllElementsByLabel(label);
      const disambig = allCandidates.length > 0
        ? `\n${buildDisambiguationGraph(label, allCandidates)}`
        : "";
      const reason = label.trim()
        ? `No input, textarea, or contenteditable found matching label "${label}" — check label spelling or scroll to reveal the field${disambig}`
        : `No focused or visible input/textarea/contenteditable — make sure a field is focused or provide a label`;
      console.warn(`[Agent Tool] type: ${reason}`);
      return { success: false, failureReason: reason };
    }

    case "scroll": {
      const amount = params.direction === "up" ? -600 : 600;
      window.scrollBy({ top: amount, behavior: "smooth" });
      return { success: true };
    }

    case "done": {
      const doneMsg = params.reason ?? "Mission complete";
      console.log(`[Agent Tool] done — ${doneMsg}`);
      showAgentMessage(doneMsg, "success", 8000);
      return { success: false, failureReason: undefined };
    }

    case "message": {
      const text = params.message ?? params.reason ?? "";
      if (text) {
        console.log(`[Agent Tool] message — ${text}`);
        showAgentMessage(text, "info");
      }
      return { success: true };
    }

    case "delay": {
      const ms = typeof params.ms === "number" ? params.ms : parseInt(String(params.ms ?? "1000"), 10);
      const wait = isNaN(ms) ? 1000 : Math.min(ms, 30000); // cap at 30s
      console.log(`[Agent Tool] delay — waiting ${wait}ms`);
      await new Promise<void>((r) => setTimeout(r, wait));
      return { success: true };
    }

    default:
      console.error(`[Agent Tool] unknown tool: ${tool}`);
      return { success: false, failureReason: `Unknown tool "${tool}"` };
  }
}

/**
 * Executes a prediction returned by the agent loop.
 * Stores any failure reason in state.lastActionFailure so the next predict
 * call can include it in the postActionObservation sent to the AI.
 */
export async function executeForAgent(prediction: RankedPrediction): Promise<boolean> {
  // Import state lazily to avoid a circular import at module level
  const { state } = await import("../state");
  state.lastActionFailure = null;

  if (prediction.action.selector.startsWith("__tool__:")) {
    const toolCall: AgentToolCall = JSON.parse(
      prediction.action.selector.slice("__tool__:".length),
    );
    const result = await executeAgentToolCall(toolCall);
    if (!result.success && result.failureReason) {
      state.lastActionFailure = result.failureReason;
    }
    return result.success;
  }

  // Should never reach here with the current tool-call only prediction path.
  console.error(
    "[Agent] executeForAgent received a non-tool prediction — this is unexpected.",
    prediction.action.selector,
  );
  return false;
}
