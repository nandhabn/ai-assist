import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";
import { showAgentMessage } from "./helpers";

/**
 * Done tool — signals mission completion.
 * Displays a success toast and returns success: false so the agent loop
 * recognises the terminal state (no further action should be taken).
 */
export class DoneTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const doneMsg = params.reason ?? "Mission complete";
    console.log(`[Agent Tool] done — ${doneMsg}`);
    showAgentMessage(doneMsg, "success", 8000);
    // success: false terminates the agent loop — this is intentional.
    return { success: false, failureReason: undefined };
  }
}
