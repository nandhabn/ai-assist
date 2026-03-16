import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";

/** Maximum allowed delay to prevent the agent from stalling indefinitely. */
const MAX_DELAY_MS = 30_000;

/**
 * Delay tool — pauses execution for a specified number of milliseconds.
 * Useful for waiting for animations or slow page loads before the next action.
 */
export class DelayTool implements ToolHandler {
  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const raw =
      typeof params.ms === "number"
        ? params.ms
        : parseInt(String(params.ms ?? "1000"), 10);
    const wait = isNaN(raw) ? 1000 : Math.min(raw, MAX_DELAY_MS);
    console.log(`[Agent Tool] delay — waiting ${wait}ms`);
    await new Promise<void>((r) => setTimeout(r, wait));
    return { success: true };
  }
}
