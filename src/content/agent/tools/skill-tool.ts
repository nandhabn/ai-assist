import type { AgentToolParams } from "@/types/ai";
import type { SkillToolStep } from "@/utils/skillsStorage";
import type { ExecuteResult, ToolHandler } from "./types";
import { toolRegistry } from "./registry";

/**
 * SkillToolHandler — wraps a user-defined skill tool as a first-class registry entry.
 *
 * Supports two execution modes:
 *   - Steps mode: runs each SkillToolStep through the registry (built-ins compose naturally).
 *   - Code mode:  executes a JS function body in the content-script context (full DOM access).
 *
 * Exactly one of `steps` or `code` should be supplied; `code` takes precedence.
 */
export class SkillToolHandler implements ToolHandler {
  constructor(
    private readonly name: string,
    private readonly steps: SkillToolStep[],
    private readonly code?: string,
  ) {}

  async execute(params: AgentToolParams): Promise<ExecuteResult> {
    // ── Code mode ────────────────────────────────────────────────────────────
    if (this.code?.trim()) {
      try {
        // eslint-disable-next-line no-new-func
        const runner = new Function(
          "params",
          `"use strict"; return (async (params) => { ${this.code} })(params);`,
        );
        const result = await runner(params);
        if (result === undefined || result === null) return { success: true };
        if (typeof result === "object" && "success" in result) {
          return {
            success: Boolean(result.success),
            ...(result.failureReason !== undefined
              ? { failureReason: String(result.failureReason) }
              : {}),
          };
        }
        console.warn(`[SkillTool "${this.name}"] unexpected return value:`, result);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SkillTool "${this.name}"] runtime error:`, err);
        return { success: false, failureReason: `Runtime error: ${msg}` };
      }
    }

    // ── Steps mode ───────────────────────────────────────────────────────────
    console.log(`[Agent Skill] "${this.name}" — running ${this.steps.length} steps`);

    for (const step of this.steps) {
      const result = await toolRegistry.execute({
        tool: step.tool,
        params: {
          label: step.label,
          text: step.text,
          url: step.url,
          direction: step.direction,
          message: step.message,
          ms: step.ms,
        },
        reasoning: `skill "${this.name}" step: ${step.tool}`,
        confidenceEstimate: 1,
      });

      if (!result.success) {
        console.warn(
          `[Agent Skill] "${this.name}" aborted at step "${step.tool}": ${result.failureReason}`,
        );
        return result;
      }

      await new Promise<void>((r) => setTimeout(r, 300));
    }

    return { success: true };
  }
}

