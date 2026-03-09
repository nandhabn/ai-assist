/**
 * DOM execution helpers for the agent.
 * All functions are purely DOM-driven — no shared state dependency.
 */

import type { AgentToolCall } from "@/types/ai";
import type { RankedPrediction } from "@/utils/predictionEngine";

// ─── Element finders ─────────────────────────────────────────────────────────

/**
 * Finds an interactive element on the page whose visible label matches label.
 * Priority: exact aria-label/title/placeholder → exact textContent → substring.
 */
export function findElementByLabel(label: string): HTMLElement | null {
  const needle = label.toLowerCase().trim();
  const selectors = [
    "button", "a", "input:not([type=hidden])", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="option"]', "[tabindex]",
  ].join(",");

  const all = Array.from(document.querySelectorAll<HTMLElement>(selectors)).filter((el) => {
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      (el.offsetWidth > 0 || el.offsetHeight > 0)
    );
  });

  const text = (el: HTMLElement) =>
    (
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.getAttribute("placeholder") ??
      el.textContent ??
      ""
    )
      .toLowerCase()
      .trim();

  return (
    all.find((el) => text(el) === needle) ??
    all.find((el) => text(el).startsWith(needle)) ??
    all.find((el) => text(el).includes(needle)) ??
    null
  );
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

/**
 * Executes a structured AgentToolCall (navigate / click / type / scroll / done).
 * Returns true on success, false when the tool signals completion or fails.
 */
export async function executeAgentToolCall(toolCall: AgentToolCall): Promise<boolean> {
  const { tool, params } = toolCall;
  console.log(`[Agent Tool] ${tool}`, params);

  switch (tool) {
    case "navigate": {
      if (!params.url) {
        console.error("[Agent Tool] navigate: missing url");
        return false;
      }
      window.location.href = params.url;
      return true;
    }

    case "click": {
      const label = params.label ?? "";
      const el = findElementByLabel(label);
      if (el) {
        el.scrollIntoView({ behavior: "instant", block: "center" });
        await new Promise<void>((r) => setTimeout(r, 80));
        el.click();
        return true;
      }
      const href = findNavHrefByLabel(label);
      if (href) {
        console.log(`[Agent Tool] click fallback via href: ${href}`);
        window.location.href = href;
        return true;
      }
      console.warn(`[Agent Tool] click: no element found for label "${label}"`);
      return false;
    }

    case "type": {
      const label = params.label ?? "";
      const text = params.text ?? "";

      // First, look only among actual typeable elements (input / textarea).
      // This avoids accidentally matching a button whose aria-label contains
      // the same words (e.g. Google's "Search by voice" button vs the text input).
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
      let el: HTMLInputElement | HTMLTextAreaElement | null =
        typeableAll.find((e) => typeableText(e) === needle) ??
        typeableAll.find((e) => typeableText(e).includes(needle)) ??
        typeableAll.find((e) => needle.includes(typeableText(e)) && typeableText(e).length > 2) ??
        null;

      // If no typeable-specific match, try the broad element finder but only
      // accept it when it is actually an input or textarea.
      if (!el) {
        const broad = findElementByLabel(label);
        if (broad && (broad.tagName.toLowerCase() === "input" || broad.tagName.toLowerCase() === "textarea")) {
          el = broad as HTMLInputElement | HTMLTextAreaElement;
        }
      }

      if (!el) {
        console.warn(`[Agent Tool] type: no input/textarea found for label "${label}"`);
        return false;
      }

      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.focus();
      await new Promise<void>((r) => setTimeout(r, 150));

      const tag = el.tagName.toLowerCase();
      const proto =
        tag === "textarea"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;

      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise<void>((r) => setTimeout(r, 300));

      const enterOpts: KeyboardEventInit = {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      };
      el.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
      el.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
      el.dispatchEvent(new KeyboardEvent("keyup", enterOpts));
      return true;
    }

    case "scroll": {
      const amount = params.direction === "up" ? -600 : 600;
      window.scrollBy({ top: amount, behavior: "smooth" });
      return true;
    }

    case "done": {
      console.log(`[Agent Tool] done — ${params.reason ?? "mission complete"}`);
      return false;
    }

    default:
      console.error(`[Agent Tool] unknown tool: ${tool}`);
      return false;
  }
}

/**
 * Executes a prediction returned by the agent loop.
 * All predictions are tool-call sentinels (__tool__:JSON) produced by predictForAgent().
 */
export async function executeForAgent(prediction: RankedPrediction): Promise<boolean> {
  if (prediction.action.selector.startsWith("__tool__:")) {
    const toolCall: AgentToolCall = JSON.parse(
      prediction.action.selector.slice("__tool__:".length),
    );
    return executeAgentToolCall(toolCall);
  }

  // Should never reach here with the current tool-call only prediction path.
  console.error(
    "[Agent] executeForAgent received a non-tool prediction — this is unexpected.",
    prediction.action.selector,
  );
  return false;
}
