import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";
import { showAgentMessage } from "./helpers";

/**
 * Message tool — shows an informational toast to the user without taking a DOM action.
 */
export class MessageTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const text = params.message ?? params.reason ?? "";
    if (text) {
      console.log(`[Agent Tool] message — ${text}`);
      showAgentMessage(text, "info");
    }
    return { success: true };
  }
}
