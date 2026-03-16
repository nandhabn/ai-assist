/**
 * Agent execution — public API.
 *
 * The actual tool implementations live in ./tools/<name>.ts.
 * This module re-exports all helpers and types for backward-compat, and
 * delegates executeAgentToolCall() to the tool registry.
 */

import type { AgentToolCall } from "@/types/ai";
import type { RankedPrediction } from "@/types/ai";

// ── Tool registry (side-effect: registers all built-in tools) ─────────────────
import { toolRegistry } from "./tools";
import type { ExecuteResult } from "./tools";

// ── Re-export everything the rest of the codebase imports from this file ───────
export {
  showAgentMessage,
  findElementByLabel,
  findAllElementsByLabel,
  findNavHrefByLabel,
  extractNavigationUrl,
  buildDisambiguationGraph,
  scoreElement,
  buildDomPath,
} from "./tools";
export type { LabelCandidate, ExecuteResult } from "./tools";

// ─── Public tool-call API ─────────────────────────────────────────────────────

/**
 * Executes a structured AgentToolCall by delegating to the registered tool handler.
 * Skill tools (pre-resolved multi-step sequences) are handled inside the registry.
 */
export async function executeAgentToolCall(
  toolCall: AgentToolCall,
): Promise<ExecuteResult> {
  return toolRegistry.execute(toolCall);
}

/**
 * Executes a prediction returned by the agent loop.
 * Stores any failure reason in state.lastActionFailure so the next predict
 * call can include it in the postActionObservation sent to the AI.
 */
export async function executeForAgent(
  prediction: RankedPrediction,
): Promise<boolean> {
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
