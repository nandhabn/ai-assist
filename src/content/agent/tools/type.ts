import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";
import {
  scoreElement,
  buildDomPath,
  findElementByLabel,
  findAllElementsByLabel,
  buildDisambiguationGraph,
} from "./helpers";

/**
 * Type tool — types text into an input, textarea, or contenteditable element.
 *
 * For React/framework-managed inputs, it uses the native setter + synthetic events
 * so the framework state machine sees the change. For contenteditable elements
 * (e.g. tweet composer) it dispatches per-character keyboard events.
 */
export class TypeTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const label = params.label ?? "";
    const text = params.text ?? "";

    // ── Helpers ────────────────────────────────────────────────────────────

    /** Type text into a contenteditable element, dispatching per-character events. */
    const typeIntoContentEditable = async (el: HTMLElement) => {
      el.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      await new Promise<void>((r) => setTimeout(r, 30));

      for (const char of Array.from(text)) {
        const keyOpts: KeyboardEventInit = {
          key: char,
          code: `Key${char.toUpperCase()}`,
          keyCode: char.charCodeAt(0),
          which: char.charCodeAt(0),
          bubbles: true,
          cancelable: true,
        };
        el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
        el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
        document.execCommand("insertText", false, char);
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: char,
          }),
        );
        el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    };

    /** Type into a standard input or textarea using the native setter for React compat. */
    const typeIntoInput = (el: HTMLInputElement | HTMLTextAreaElement) => {
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
    };

    /** Build a composite label string for matching against an input element. */
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

    // ── 1. No label — type into whatever is currently focused ──────────────
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
    }

    // ── 2. Label-based: search standard input/textarea elements ───────────
    const typeableSelectors =
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea";
    const typeableAll = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(typeableSelectors),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetWidth > 0;
    });

    const needle = label.toLowerCase().trim();
    const matchedInputs = typeableAll.filter((e) => {
      const t = typeableText(e);
      return t === needle || t.includes(needle) || (needle && needle.includes(t) && t.length > 2);
    });

    if (matchedInputs.length > 1) {
      console.log(
        `[Agent Tool] type: ${matchedInputs.length} inputs match "${label}" — using highest-scored`,
      );
      matchedInputs.forEach((e, i) =>
        console.log(`  [${i + 1}] ${buildDomPath(e)} score=${scoreElement(e)}`),
      );
    }

    let inputEl: HTMLInputElement | HTMLTextAreaElement | null =
      matchedInputs.sort((a, b) => scoreElement(b) - scoreElement(a))[0] ?? null;

    if (!inputEl) {
      const broad = findElementByLabel(label);
      if (
        broad &&
        (broad.tagName.toLowerCase() === "input" || broad.tagName.toLowerCase() === "textarea")
      ) {
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

    // ── 3. Fallback: contenteditable elements ─────────────────────────────
    const contentEditables = Array.from(
      document.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='']"),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetWidth > 0;
    });

    const matchedCEs = needle
      ? contentEditables.filter((e) => {
          const t = typeableText(e);
          return t === needle || t.includes(needle);
        })
      : [];

    const sortedCEs = contentEditables
      .map((e) => ({ e, score: scoreElement(e) }))
      .sort((a, b) => b.score - a.score);

    let ceEl: HTMLElement | null = null;
    if (matchedCEs.length > 0) {
      if (matchedCEs.length > 1) {
        console.log(
          `[Agent Tool] type: ${matchedCEs.length} contenteditable elements match "${label}" — using highest-scored`,
        );
        matchedCEs.forEach((e, i) =>
          console.log(`  [${i + 1}] ${buildDomPath(e)} score=${scoreElement(e)}`),
        );
      }
      ceEl = matchedCEs.sort((a, b) => scoreElement(b) - scoreElement(a))[0];
    } else if (sortedCEs.length > 0) {
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

    // ── 4. Failure — build disambiguation graph for the AI ────────────────
    const allCandidates = findAllElementsByLabel(label);
    const disambig =
      allCandidates.length > 0 ? `\n${buildDisambiguationGraph(label, allCandidates)}` : "";
    const reason = label.trim()
      ? `No input, textarea, or contenteditable found matching label "${label}" — check label spelling or scroll to reveal the field${disambig}`
      : `No focused or visible input/textarea/contenteditable — make sure a field is focused or provide a label`;
    console.warn(`[Agent Tool] type: ${reason}`);
    return { success: false, failureReason: reason };
  }
}
