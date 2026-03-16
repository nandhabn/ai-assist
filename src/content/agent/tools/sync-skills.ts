/**
 * syncSkillsToRegistry — binds enabled AgentSkill tools into the tool registry
 * at runtime so the AI can call them by name exactly like any built-in tool.
 *
 * Call this:
 *   • Once at agent initialisation (agentManager.ts).
 *   • Each time predictForAgent() loads skills (prediction.ts) — ensures the
 *     registry is fresh even if the user toggled skills between steps.
 *   • From a chrome.storage.onChanged listener to pick up live edits from the popup.
 */

import type { AgentSkill } from "@/utils/skillsStorage";
import { toolRegistry } from "./registry";
import { SkillToolHandler } from "./skill-tool";

/**
 * Replaces all skill-derived tool registrations with the tools defined in
 * `skills` (only enabled skills are considered).
 *
 * Previously registered skill tools that no longer exist are automatically
 * removed; new ones are added; and changed step sequences are replaced.
 */
export function syncSkillsToRegistry(skills: AgentSkill[]): void {
  // Wipe all previous skill-tool registrations so stale/disabled ones don't linger.
  toolRegistry.clearSkillTools();

  const added: string[] = [];

  for (const skill of skills) {
    if (!skill.enabled) continue;
    for (const skillTool of skill.tools ?? []) {
      if (!skillTool.name) continue;
      // Require either code or at least one step
      if (!skillTool.code?.trim() && !skillTool.steps?.length) continue;
      toolRegistry.registerSkillTool(
        skillTool.name,
        new SkillToolHandler(skillTool.name, skillTool.steps ?? [], skillTool.code),
      );
      added.push(skillTool.name);
    }
  }

  if (added.length > 0) {
    console.log(`[Agent Tools] Registered skill tools: ${added.join(", ")}`);
  }
}

/**
 * Loads all enabled skills from chrome.storage.local and syncs them into
 * the registry. Returns the skills array so callers (e.g. prediction.ts)
 * can attach it to the AI context without a second storage read.
 */
export async function loadAndSyncSkills(): Promise<AgentSkill[]> {
  const { getEnabledSkills } = await import("@/utils/skillsStorage");
  const skills = await getEnabledSkills();
  syncSkillsToRegistry(skills);
  return skills;
}
