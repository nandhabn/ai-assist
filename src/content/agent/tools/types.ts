/**
 * Core abstractions for the agent tool system.
 *
 * Adding a new tool:
 *   1. Implement ToolHandler in a new file (e.g. tools/my-tool.ts).
 *   2. Register it in tools/index.ts via toolRegistry.register("my-tool", new MyTool()).
 */

import type { AgentToolParams } from "@/types/ai";

/**
 * The result returned by every tool execution.
 * `success: false` + a `failureReason` surfaces the problem to the AI in the
 * next postActionObservation so it can choose a different approach.
 */
export interface ExecuteResult {
  success: boolean;
  failureReason?: string;
}

/**
 * Interface every agent tool must implement.
 * Each tool is responsible for one specific action type (navigate, click, etc.).
 */
export interface ToolHandler {
  /**
   * Execute the tool using the provided parameters.
   * @param params  Parameter bag from the AI's AgentToolCall.
   * @returns       ExecuteResult indicating success or describing why the action failed.
   */
  execute(params: AgentToolParams): Promise<ExecuteResult>;
}
