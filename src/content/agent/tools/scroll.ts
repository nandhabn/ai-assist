import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";

/**
 * Scroll tool — scrolls the viewport up or down by a fixed amount.
 */
export class ScrollTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const amount = params.direction === "up" ? -600 : 600;
    window.scrollBy({ top: amount, behavior: "smooth" });
    return { success: true };
  }
}
