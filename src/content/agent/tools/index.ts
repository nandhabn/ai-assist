/**
 * Agent Tools — public entry point.
 *
 * Registers all built-in tool handlers and re-exports the registry,
 * types, and helpers so consumers only need a single import.
 *
 * Adding a new tool:
 *   1. Create `tools/<name>.ts` implementing ToolHandler.
 *   2. Import and register it below.
 *   3. That's it — the registry and executeAgentToolCall() pick it up automatically.
 *
 * Example:
 *   import { WaitForElementTool } from "./wait-for-element";
 *   toolRegistry.register("wait_for_element", new WaitForElementTool());
 */

export { toolRegistry } from "./registry";
export type { ToolHandler, ExecuteResult } from "./types";
export {
  showAgentMessage,
  findElementByLabel,
  findAllElementsByLabel,
  findNavHrefByLabel,
  extractNavigationUrl,
  buildDisambiguationGraph,
  scoreElement,
  buildDomPath,
  elementLabelText,
} from "./helpers";
export type { LabelCandidate } from "./helpers";
export { SkillToolHandler } from "./skill-tool";
export { syncSkillsToRegistry, loadAndSyncSkills } from "./sync-skills";

// ── Register built-in tools ──────────────────────────────────────────────────
import { toolRegistry } from "./registry";
import { NavigateTool } from "./navigate";
import { ClickTool } from "./click";
import { TypeTool } from "./type";
import { ScrollTool } from "./scroll";
import { DoneTool } from "./done";
import { MessageTool } from "./message";
import { DelayTool } from "./delay";
import { FillFormTool } from "./fill-form";

toolRegistry.register("navigate", new NavigateTool());
toolRegistry.register("click", new ClickTool());
toolRegistry.register("type", new TypeTool());
toolRegistry.register("scroll", new ScrollTool());
toolRegistry.register("done", new DoneTool());
toolRegistry.register("message", new MessageTool());
toolRegistry.register("delay", new DelayTool());
toolRegistry.register("fill_form", new FillFormTool());
