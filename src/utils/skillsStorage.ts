// src/utils/skillsStorage.ts

/**
 * Agent Skills — user-defined instruction packages that are injected into the
 * AI agent prompt when active.  Modelled after VS Code's SKILL.md concept:
 * each skill has a name, description (shown to the AI so it knows when to apply
 * it), a freeform instructions body, and optionally custom tools.
 *
 * Skills are stored in chrome.storage.local under the key
 * "flowRecorder_agentSkills".  They are completely local — never sent to any
 * backend.
 */

const SKILLS_KEY = "flowRecorder_agentSkills";

/**
 * A single step inside a SkillTool.  Maps directly onto the built-in agent
 * tool primitives so it can be executed by executeAgentToolCall().
 */
export interface SkillToolStep {
  tool: "click" | "type" | "scroll" | "navigate" | "message" | "delay";
  /** click / type: visible element label */
  label?: string;
  /** type: text to enter */
  text?: string;
  /** navigate: destination URL */
  url?: string;
  /** scroll: direction */
  direction?: "up" | "down";
  /** message: text to show */
  message?: string;
  /** delay: milliseconds to wait */
  ms?: number;
}

/**
 * A named macro the AI can call as if it were a built-in tool.
 * When the AI picks this tool, its steps execute sequentially.
 */
export interface SkillTool {
  /** Tool name the AI uses in its JSON output (lowercase, underscores, no spaces). */
  name: string;
  /** One-line description exposed to the AI explaining when to use this tool. */
  description: string;
  /** Ordered sequence of built-in steps to run when invoked. */
  steps: SkillToolStep[];
}

/**
 * Parses the simple DSL the user types into the tool-steps textarea:
 *   click: Sign In
 *   type: Email | user@example.com
 *   navigate: https://example.com
 *   scroll: down
 *   message: Logged in
 *   delay: 2000
 */
export function parseToolSteps(raw: string): SkillToolStep[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): SkillToolStep | null => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const tool = line.slice(0, colonIdx).trim().toLowerCase() as SkillToolStep["tool"];
      const rest = line.slice(colonIdx + 1).trim();
      switch (tool) {
        case "click":
          return { tool: "click", label: rest };
        case "type": {
          const pipeIdx = rest.indexOf("|");
          if (pipeIdx === -1) return { tool: "type", label: rest, text: "" };
          return { tool: "type", label: rest.slice(0, pipeIdx).trim(), text: rest.slice(pipeIdx + 1).trim() };
        }
        case "navigate":
          return { tool: "navigate", url: rest };
        case "scroll":
          return { tool: "scroll", direction: rest === "up" ? "up" : "down" };
        case "message":
          return { tool: "message", message: rest };
        case "delay": {
          const ms = parseInt(rest, 10);
          return { tool: "delay", ms: isNaN(ms) ? 1000 : ms };
        }
        default:
          return null;
      }
    })
    .filter((s): s is SkillToolStep => s !== null);
}

/** Serialises SkillToolStep[] back to the user-facing DSL string. */
export function serializeToolSteps(steps: SkillToolStep[]): string {
  return steps
    .map((s) => {
      switch (s.tool) {
        case "click":    return `click: ${s.label ?? ""}`;
        case "type":     return s.label?.trim() ? `type: ${s.label} | ${s.text ?? ""}` : `type: | ${s.text ?? ""}`;
        case "navigate": return `navigate: ${s.url ?? ""}`;
        case "scroll":   return `scroll: ${s.direction ?? "down"}`;
        case "message":  return `message: ${s.message ?? ""}`;
        case "delay":    return `delay: ${s.ms ?? 1000}`;
        default: return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

export interface AgentSkill {
  /** Unique ID (generated on creation). */
  id: string;
  /** Short human-readable name, e.g. "Checkout Flow". */
  name: string;
  /**
   * One-line description surfaced directly to the AI so it understands when
   * the skill applies.  Example: "Handles e-commerce checkout and cart flows."
   */
  description: string;
  /**
   * The full instruction body injected into the agent prompt.
   * Can be multi-line markdown / plain text.  Keep it concise and actionable.
   */
  instructions: string;
  /** Custom tools this skill exposes to the AI. */
  tools?: SkillTool[];
  /** When false the skill is saved but never injected into prompts. */
  enabled: boolean;
  /** Unix ms timestamp of creation. */
  createdAt: number;
}

export async function getSkills(): Promise<AgentSkill[]> {
  const data = await chrome.storage.local.get(SKILLS_KEY);
  return (data[SKILLS_KEY] as AgentSkill[]) || [];
}

export async function saveSkills(skills: AgentSkill[]): Promise<void> {
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
}

export async function addSkill(
  skill: Omit<AgentSkill, "id" | "createdAt">,
): Promise<AgentSkill> {
  const skills = await getSkills();
  const newSkill: AgentSkill = {
    ...skill,
    id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
  };
  skills.push(newSkill);
  await saveSkills(skills);
  return newSkill;
}

export async function updateSkill(
  id: string,
  patch: Partial<Omit<AgentSkill, "id" | "createdAt">>,
): Promise<void> {
  const skills = await getSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx !== -1) {
    skills[idx] = { ...skills[idx], ...patch };
    await saveSkills(skills);
  }
}

export async function deleteSkill(id: string): Promise<void> {
  const skills = await getSkills();
  await saveSkills(skills.filter((s) => s.id !== id));
}

export async function getEnabledSkills(): Promise<AgentSkill[]> {
  const skills = await getSkills();
  return skills.filter((s) => s.enabled);
}
