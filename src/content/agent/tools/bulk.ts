import type { AgentToolParams } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";
import { toolRegistry } from "./registry";

/**
 * Bulk tool — executes an ordered list of sub-tool calls in sequence.
 *
 * Use this when you know several independent actions must all be taken in a row
 * (e.g. clicking every "Not Viewed" button to mark all files as viewed, or
 * expanding all diffs before submitting a review).
 *
 * The AI provides:
 *   params.steps — an array of sub-calls, each with: tool, params (and optionally
 *                  reasoning). They are executed in order with a short setttle
 *                  delay between runs. Execution stops on the first failure and
 *                  reports which step index failed.
 *
 * Example:
 * {
 *   "tool": "bulk",
 *   "params": {
 *     "steps": [
 *       { "tool": "click", "params": { "label": "Not Viewed" } },
 *       { "tool": "click", "params": { "label": "Not Viewed" } },
 *       { "tool": "click", "params": { "label": "Submit" } }
 *     ]
 *   },
 *   "reasoning": "mark all files viewed then submit the review"
 * }
 */
export class BulkTool implements ToolHandler {
  /** Delay in ms between sub-steps so the page can settle between rapid actions. */
  private readonly STEP_DELAY_MS = 300;

  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    const steps = params.steps;

    if (!Array.isArray(steps) || steps.length === 0) {
      return {
        success: false,
        failureReason: "bulk: 'steps' must be a non-empty array of tool calls",
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as { tool: string; params?: AgentToolParams; reasoning?: string };

      if (!step || typeof step.tool !== "string") {
        return {
          success: false,
          failureReason: `bulk: step[${i}] is missing a 'tool' field`,
        };
      }

      const handler = toolRegistry.get(step.tool);
      if (!handler) {
        return {
          success: false,
          failureReason: `bulk: step[${i}] references unknown tool "${step.tool}"`,
        };
      }

      const result = await handler.execute(step.params ?? {});
      if (!result.success) {
        return {
          success: false,
          failureReason: `bulk: step[${i}] (${step.tool}) failed — ${result.failureReason ?? "unknown error"}`,
        };
      }

      if (i < steps.length - 1) {
        // Small pause between steps so the DOM can react to each action
        await new Promise<void>((r) => setTimeout(r, this.STEP_DELAY_MS));
      }
    }

    return { success: true };
  }
}
