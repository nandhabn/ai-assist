import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";
import {
  findAllElementsByLabel,
  findNavHrefByLabel,
  buildDisambiguationGraph,
} from "./helpers";

/**
 * Click tool — finds the best-matching interactive element by label and clicks it.
 *
 * Falls back to href navigation when a matching <a> element is found but clicking
 * would open a new tab. Returns a detailed failure reason so the AI can retry with
 * a more specific label.
 */
export class ClickTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const label = params.label ?? "";
    const candidates = findAllElementsByLabel(label);

    if (candidates.length > 0) {
      const el = candidates[0].el;
      if (candidates.length > 1) {
        console.log(
          `[Agent Tool] click: multiple matches for "${label}" — ${buildDisambiguationGraph(label, candidates)}`,
        );
      }
      el.scrollIntoView({ behavior: "instant", block: "center" });
      await new Promise<void>((r) => setTimeout(r, 80));

      // Prevent new-tab navigation: force same-tab for anchor elements
      const anchor =
        el instanceof HTMLAnchorElement
          ? el
          : el.closest<HTMLAnchorElement>("a[href]");
      if (anchor && anchor.href && anchor.target && anchor.target !== "_self") {
        anchor.target = "_self";
        anchor.rel = "noreferrer";
      }

      el.click();
      return { success: true };
    }

    // Fallback: navigate via href when no clickable element was found
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
}
