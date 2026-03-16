import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";

/**
 * Navigate tool — immediately redirects the current tab to the given URL.
 */
export class NavigateTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    if (!params.url) {
      return { success: false, failureReason: "navigate tool called without a URL" };
    }
    window.location.href = params.url;
    return { success: true };
  }
}
