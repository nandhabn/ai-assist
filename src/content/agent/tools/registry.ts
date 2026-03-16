/**
 * ToolRegistry — central registry for agent tool handlers.
 *
 * All built-in tools are pre-registered in tools/index.ts.
 * Third-party or custom tools can be added at runtime via register().
 *
 * Usage:
 *   import { toolRegistry } from "./tools";
 *
 *   // Register a custom tool
 *   toolRegistry.register("my-tool", new MyTool());
 *
 *   // Execute a tool call
 *   const result = await toolRegistry.execute({ tool: "click", params: { label: "Submit" }, ... });
 */

import type { AgentToolCall } from "@/types/ai";
import type { ExecuteResult, ToolHandler } from "./types";

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();
  /** Names of tools that were registered from skills (vs built-ins). */
  private readonly skillToolNames = new Set<string>();

  /**
   * Register a handler for a tool name.
   * Calling register() with an existing name replaces the handler,
   * which allows overriding built-in tools.
   */
  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  /**
   * Register a skill-derived tool handler. Tracked separately so
   * syncSkillsToRegistry() can cleanly replace all skill tools on each sync.
   */
  registerSkillTool(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
    this.skillToolNames.add(name);
  }

  /**
   * Remove a previously registered tool. No-op if the name is unknown.
   */
  unregister(name: string): void {
    this.handlers.delete(name);
    this.skillToolNames.delete(name);
  }

  /**
   * Remove all tools that were registered via registerSkillTool().
   * Called by syncSkillsToRegistry() before re-registering the current set.
   */
  clearSkillTools(): void {
    for (const name of this.skillToolNames) {
      this.handlers.delete(name);
    }
    this.skillToolNames.clear();
  }

  /** Returns the handler for a tool name, or undefined if not registered. */
  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** Returns true if a handler is registered for the given name. */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Returns the names of all registered tools. */
  list(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Returns the names of tools registered from skills. */
  listSkillTools(): string[] {
    return Array.from(this.skillToolNames);
  }

  /**
   * Execute a tool call, delegating to the appropriate handler.
   *
   * Skill tools (pre-resolved multi-step sequences) are executed first by
   * running each step through this same registry, so custom tools compose naturally.
   */
  async execute(toolCall: AgentToolCall): Promise<ExecuteResult> {
    const { tool, params } = toolCall;
    console.log(`[Agent Tool] ${tool}`, params);

    // ── Skill tool: run the pre-resolved step sequence ──────────────────────
    if (toolCall.skillSteps && toolCall.skillSteps.length > 0) {
      console.log(
        `[Agent Tool] Running skill tool "${tool}" (${toolCall.skillSteps.length} steps)`,
      );
      for (const step of toolCall.skillSteps) {
        const stepCall: AgentToolCall = {
          tool: step.tool,
          params: {
            label: step.label,
            text: step.text,
            url: step.url,
            direction: step.direction,
            message: step.message,
            ms: step.ms,
          },
          reasoning: `skill step: ${step.tool}`,
          confidenceEstimate: 1,
        };
        const result = await this.execute(stepCall);
        if (!result.success) return result;
        await new Promise<void>((r) => setTimeout(r, 300));
      }
      return { success: true };
    }

    // ── Standard tool dispatch ───────────────────────────────────────────────
    const handler = this.handlers.get(tool);
    if (!handler) {
      console.error(`[Agent Tool] unknown tool: "${tool}"`);
      return { success: false, failureReason: `Unknown tool "${tool}"` };
    }

    return handler.execute(params);
  }
}

/** The shared singleton registry. All built-in tools are registered in tools/index.ts. */
export const toolRegistry = new ToolRegistry();
