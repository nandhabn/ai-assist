/**
 * Centralized AI Prompt Templates
 *
 * All prompts sent to AI providers live here so they're easy to find and edit.
 * Each prompt is a function that accepts the dynamic data and returns the final string.
 *
 * To edit a prompt, simply change the template literal below.
 * The providers (chatgptProvider, chatgptTabProvider, geminiProvider) import from here.
 */

import { CompactContext, FormFieldInfo } from "@/types/ai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an array of FormFieldInfo into a human-readable description string
 * that is included in AI prompts. Shared across all providers.
 */
export function formatFieldDescriptions(fields: FormFieldInfo[]): string {
  return fields
    .map((f, i) => {
      const parts: string[] = [`Field ${i + 1}:`];
      if (f.name) parts.push(`name="${f.name}"`);
      if (f.id) parts.push(`id="${f.id}"`);
      parts.push(`type="${f.type}"`);
      if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
      if (f.labelText) parts.push(`label="${f.labelText}"`);
      if (f.ariaLabel) parts.push(`aria-label="${f.ariaLabel}"`);
      if (f.options && f.options.length > 0)
        parts.push(`options=[${f.options.map((o) => `"${o}"`).join(", ")}]`);
      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Builds the page-metadata block used in prediction prompts.
 * Returns an empty string when no metadata is available.
 */
export function formatPageMeta(
  pageMeta: CompactContext["pageMeta"],
  indent = "",
): string {
  if (!pageMeta) return "";
  return [
    `${indent}Page Metadata:`,
    `${indent}  URL: ${pageMeta.url}`,
    `${indent}  Title: ${pageMeta.title}`,
    `${indent}  Description: ${pageMeta.description || "N/A"}`,
    `${indent}  Site: ${pageMeta.ogSiteName || "N/A"}`,
    `${indent}  Type: ${pageMeta.ogType || "N/A"}`,
    `${indent}  Keywords: ${pageMeta.keywords || "N/A"}`,
  ].join("\n");
}

// ─── Prediction Prompts ───────────────────────────────────────────────────────

/** System message used by ChatGPT API for prediction calls. */
export const PREDICTION_SYSTEM_PROMPT =
  "You are an expert at predicting user actions on a web page. If a user mission is provided, prioritize actions that advance that mission. Respond in STRICT JSON format.";

/**
 * User prompt for predicting the next action on a page.
 * Used by chatgptProvider (as user message), geminiProvider (as sole prompt),
 * and chatgptTabProvider (as combined prompt).
 */
export function buildPredictionPrompt(context: CompactContext): string {
  const {
    pageIntent,
    lastActionLabel,
    topVisibleActions,
    formFields,
    pageMeta,
    mission,
    stepHistory,
    plan,
    currentPlanStep,
  } = context;

  const metaBlock = formatPageMeta(pageMeta);
  const metaSection = metaBlock ? `\n${metaBlock}\n` : "";
  const missionSection = mission ? `\nUser Mission: ${mission}\n` : "";
  const historySection =
    stepHistory && stepHistory.length > 0
      ? `\nCompleted Steps (most recent last):\n${stepHistory
          .slice(-8)
          .map((s, i) => `  ${i + 1}. ${s.action} (on ${s.pageUrl})`)
          .join("\n")}\n`
      : "";

  // Plan section — shown prominently when available so AI follows it strictly
  const planSection = plan
    ? `\n== MISSION PLAN ==\n${plan}\n== EXECUTE PLAN STEP ${currentPlanStep ?? 1} NOW ==\n`
    : "";

  return `You are an expert at predicting user actions on a web page.
Based on the provided context, predict the single most likely next action.
${metaSection}${missionSection}${planSection}${historySection}
Current Page Intent: ${pageIntent}
Last Action Taken: ${lastActionLabel || "None"}
Visible Actions: ${JSON.stringify(topVisibleActions)}
Available Form Fields: ${JSON.stringify(formFields)}

${plan ? `IMPORTANT: You are executing a pre-approved plan. Your chosen action MUST advance plan step ${currentPlanStep ?? 1}. If that step requires navigating to a different site, pick the URL bar, address input, or the closest navigation action available.\n\n` : ""}Respond in STRICT JSON format with the following structure:
{
  "predictedActionLabel": "string (must be one of the Visible Actions)",
  "reasoning": "string (≤60 chars — one very short phrase, e.g. 'advances mission goal')",
  "confidenceEstimate": "number (a value between 0.0 and 1.0)",
  "inputText": "string (ONLY include this field when the action is to TYPE text into an input or search field — provide the exact text to type, e.g. 'iphone 17 pro'. Omit entirely for click/navigation actions.)"
}`;
}

// ─── Agent Planning Prompt ─────────────────────────────────────────────────────

/**
 * Prompt that asks the AI to produce a concise numbered action plan for the mission
 * before the agent starts executing. Returned as a plain string the user can inspect.
 */
export function buildMissionPlanPrompt(
  mission: string,
  pageTitle: string,
  pageUrl: string,
  visibleActions: string[],
): string {
  return `You are an autonomous web agent about to execute a mission on a website.
Analyse the mission and the current page, then produce a concise NUMBERED action plan (max 10 steps).

MISSION: ${mission}
CURRENT PAGE: ${pageTitle} (${pageUrl})
VISIBLE ACTIONS: ${visibleActions.slice(0, 20).join(", ")}

Rules:
- Each step must be a concrete browser action (click X, fill form Y, navigate to Z).
- Be specific about which elements or links to use based on what is visible.
- If the mission spans multiple pages, include navigation steps.
- End with a "Verify: …" step that confirms success.

Respond in STRICT JSON:
{
  "plan": "1. …\\n2. …\\n3. …",
  "estimatedSteps": <number>
}`;
}

// ─── Agent-Mode Prediction Prompts ────────────────────────────────────────────

/** System message used for agent-mode prediction (always uses AI). */
export const AGENT_PREDICTION_SYSTEM_PROMPT =
  "You are an autonomous web agent executing a multi-step mission on behalf of the user. " +
  "You observe the current page state and choose the single best action that advances the mission. " +
  "If the mission appears to be complete, set confidenceEstimate to 0. Respond in STRICT JSON format.";

/**
 * User prompt for agent-mode prediction.
 * Emphasizes the mission and includes step history for context.
 */
export function buildAgentPredictionPrompt(
  context: CompactContext,
  stepHistory: { action: string; pageUrl: string }[] = [],
): string {
  const {
    pageIntent,
    lastActionLabel,
    topVisibleActions,
    formFields,
    pageMeta,
    mission,
  } = context;

  const metaBlock = formatPageMeta(pageMeta);
  const metaSection = metaBlock ? `\n${metaBlock}\n` : "";

  const historyBlock =
    stepHistory.length > 0
      ? `\nPrevious Steps (most recent last):\n${stepHistory
          .slice(-10)
          .map((s, i) => `  ${i + 1}. ${s.action} (on ${s.pageUrl})`)
          .join("\n")}\n`
      : "";

  return `You are an autonomous agent completing the following mission:
MISSION: ${mission || "(no mission set — explore the page)"}
${metaSection}${historyBlock}
Current Page Intent: ${pageIntent}
Last Action Taken: ${lastActionLabel || "None"}
Visible Actions: ${JSON.stringify(topVisibleActions)}
Available Form Fields: ${JSON.stringify(formFields)}

Choose the single best next action that advances the mission.
If the mission appears COMPLETE (i.e. the page shows a success message, confirmation, or the goal has been achieved), set confidenceEstimate to 0 to signal completion.

Respond in STRICT JSON:
{
  "predictedActionLabel": "string (must be one of the Visible Actions, or 'MISSION_COMPLETE' if done)",
  "reasoning": "string (≤60 chars — one very short phrase, e.g. 'next step toward goal')",
  "confidenceEstimate": "number (0.0 = mission complete, 0.01-1.0 = confidence in this action)",
  "inputText": "string (ONLY include when the action is to TYPE into an input/search/textarea field — exact text to type, e.g. 'iphone 17 pro'. Omit for click/navigation actions.)"
}`;
}

// ─── Agent Tool-Call Prompt ───────────────────────────────────────────────────

/**
 * Builds the prompt for the agent tool-calling mode.
 *
 * Instead of asking the AI to pick from a list of labels and then fuzzy-matching
 * that back to a DOM element, this prompt asks the AI to call a concrete typed
 * tool (navigate / click / type / scroll / done) with explicit parameters.
 *
 * The agent executor encodes the returned AgentToolCall as a `__tool__:` selector
 * so no label-matching is involved in execution.
 */
export function buildAgentToolPrompt(context: CompactContext): string {
  const {
    pageIntent,
    pageMeta,
    mission,
    stepHistory,
    turnHistory,
    plan,
    currentPlanStep,
    pageElements,
    currentUrl,
    postActionObservation,
  } = context;

  const url = currentUrl ?? pageMeta?.url ?? "unknown";
  const title = pageMeta?.title ?? "unknown";

  const missionLine = mission
    ? `MISSION: ${mission}`
    : "MISSION: (none — explore the page)";

  const planSection = plan
    ? `\n== MISSION PLAN ==\n${plan}\n\n▶ EXECUTE STEP ${currentPlanStep ?? 1} NOW\n`
    : "";

  // ── Rich turn history (preferred) ────────────────────────────────────────
  // When full turn records are available, render them with page state + AI decision + result.
  // Falls back to the lightweight stepHistory for backward compatibility.
  let historySection = "";
  if (turnHistory && turnHistory.length > 0) {
    const turnLines = turnHistory.slice(-8).map((t, i) => {
      const pageShort = t.pageUrl.replace(/^https?:\/\//, "").slice(0, 50);
      const tc = t.toolCall;
      let decisionLine = `  Decision: ${tc.tool}`;
      if (tc.tool === "click" || tc.tool === "type") {
        decisionLine += ` "${tc.params.label ?? ""}"`;
        if (tc.tool === "type" && tc.params.text) {
          decisionLine += ` ← "${tc.params.text.slice(0, 40)}"`;
        }
      } else if (tc.tool === "navigate") {
        decisionLine += ` → ${(tc.params.url ?? "").slice(0, 60)}`;
      } else if (tc.tool === "scroll") {
        decisionLine += ` ${tc.params.direction ?? "down"}`;
      }
      const confidence = `${Math.round((tc.confidenceEstimate ?? 0) * 100)}%`;
      decisionLine += `  (confidence: ${confidence})`;
      if (tc.reasoning) decisionLine += `\n  Reasoning: ${tc.reasoning.slice(0, 80)}`;

      let resultLine = `  Outcome: ${t.success ? "success" : "FAILED"}`;
      if (t.observation) {
        const obs = t.observation;
        const parts: string[] = [];
        if (obs.urlChanged) parts.push(`navigated from ${obs.previousUrl.replace(/^https?:\/\//, "").slice(0, 40)}`);
        if (obs.newElements.length > 0) parts.push(`+${obs.newElements.length} new elements (${obs.newElements.slice(0, 3).map((l) => `"${l}"`).join(", ")}${obs.newElements.length > 3 ? "…" : ""})`);
        if (obs.removedElements.length > 0) parts.push(`-${obs.removedElements.length} removed`);
        if (parts.length > 0) resultLine += ": " + parts.join(" | ");
      }

      return `Step ${t.stepNumber} — ${pageShort}\n${decisionLine}\n${resultLine}`;
    });
    historySection = `\n== SESSION HISTORY (most recent last) ==\n${turnLines.join("\n\n")}\n`;
  } else if (stepHistory && stepHistory.length > 0) {
    // Lightweight fallback
    const lines = stepHistory.slice(-6).map((s, i) => {
      const action = s.action.slice(0, 60);
      const u = s.pageUrl.replace(/^https?:\/\//, "").slice(0, 50);
      return `  ${i + 1}. ${action}  [${u}]`;
    }).join("\n");
    historySection = `\nCompleted steps (most recent last):\n${lines}\n`;
  }

  // ── Post-action DOM observation ───────────────────────────────────────────
  let observationSection = "";
  if (postActionObservation) {
    const obs = postActionObservation;
    const lines: string[] = [];
    if (obs.urlChanged) {
      lines.push(
        `  • Page navigated away from: ${obs.previousUrl.replace(/^https?:\/\//, "").slice(0, 60)}`,
      );
    }
    if (obs.newElements.length > 0) {
      lines.push(
        `  • New elements appeared: ${obs.newElements
          .slice(0, 10)
          .map((l) => `"${l}"`)
          .join(", ")}`,
      );
    }
    if (obs.removedElements.length > 0) {
      lines.push(
        `  • Elements removed: ${obs.removedElements
          .slice(0, 10)
          .map((l) => `"${l}"`)
          .join(", ")}`,
      );
    }
    if (lines.length > 0) {
      observationSection = `\n== RESULT OF LAST ACTION (DOM re-evaluated) ==\n${lines.join("\n")}\n`;
    }
  }

  // Format page elements grouped by type for readability
  const buttons =
    pageElements
      ?.filter((e) => e.type === "button")
      .map((e) => `  • "${e.label}"`)
      .join("\n") ?? "";
  const links =
    pageElements
      ?.filter((e) => e.type === "link")
      .map((e) => `  • "${e.label}"`)
      .join("\n") ?? "";
  const inputs =
    pageElements
      ?.filter(
        (e) =>
          e.type === "input" || e.type === "textarea" || e.type === "select",
      )
      .map((e) => {
        const valueNote = e.currentValue
          ? ` (currently: "${e.currentValue}")`
          : "";
        return `  • "${e.label}" [${e.type}]${valueNote}`;
      })
      .join("\n") ?? "";

  const elementsSection = [
    buttons ? `Buttons:\n${buttons}` : "",
    links ? `Links:\n${links}` : "",
    inputs ? `Input fields:\n${inputs}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `You are an autonomous web agent executing a mission step-by-step.
Choose ONE tool call that advances the mission to the next step.

${missionLine}
Current page: ${title} (${url})
Page intent: ${pageIntent}
${planSection}${observationSection}${historySection}
Interactive elements on this page:
${elementsSection || "(no interactive elements detected)"}

Available tools:
  navigate(url)          — go directly to a full URL (use for plan steps that start a new page)
  click(label)           — click a button or link whose text matches "label"
  type(label, text)      — focus an input/select/textarea matching "label" and type "text" into it
  scroll(direction)      — scroll "up" or "down" to reveal more content
  done(reason)           — signal the mission is complete or unrecoverable

Rules:
- Use "navigate" whenever you need to go to a different website or URL — do not try to find a URL bar.
- Use "click" for buttons and links. The label must closely match one of the listed elements.
- Use "type" for search boxes, text inputs, dropdowns. Provide the exact text to enter.
- Only call "done" when the page confirms success (thank-you message, order number, etc.) or when it is impossible to proceed.
- NEVER repeat an action that appears in the SESSION HISTORY as already executed on the current page.
- If the plan step requires a site you are not on, use navigate() immediately.
- Use "SESSION HISTORY" to understand what has been tried, what succeeded, and what failed.
- Use "RESULT OF LAST ACTION" (when present) to understand what the previous action concretely changed on the page.

Respond with a single JSON object only — no markdown, no extra text:
{
  "tool": "navigate|click|type|scroll|done",
  "params": {
    "url": "string (navigate only)",
    "label": "string (click / type — must match an element label above)",
    "text": "string (type only — exact text to type)",
    "direction": "up|down (scroll only)",
    "reason": "string (done only)"
  },
  "reasoning": "≤60 chars explaining this choice",
  "confidenceEstimate": 0.0
}`;
}

// ─── Form Data Generation Prompts ─────────────────────────────────────────────

/** System message used by ChatGPT API for form-data generation calls. */
export const FORM_DATA_SYSTEM_PROMPT =
  "You are a test data generator that produces realistic form data. Respond in STRICT JSON format.";

/**
 * User prompt for generating realistic test data for form fields.
 * Used by all three providers.
 */
export function buildFormDataPrompt(
  fieldDescriptions: string,
  pageContext?: string,
): string {
  return `You are a test data generator for web form automation.
Generate realistic, contextually appropriate test data for the following form fields.
${pageContext ? `Page context: ${pageContext}` : ""}

Form Fields:
${fieldDescriptions}

Rules:
- Generate realistic-looking data (e.g., real-sounding names, valid email formats, strong passwords).
- For each field, return a mapping using the field's "name" attribute as the key. If "name" is empty, use "id". If both are empty, use "label" or "aria-label".
- Emails should use @example.com or @test.com domains.
- Passwords should be strong (12+ chars, mixed case, numbers, symbols).
- Phone numbers should be in a valid format.
- For select/dropdown fields and radio button groups with options listed, you MUST pick one of the provided options exactly as written.
- All generated values should be coherent with each other (e.g., same persona).
- If a page context starting with "User mission:" is provided, tailor the generated data to fulfill that mission.

Respond in STRICT JSON format:
{
  "fieldValues": {
    "fieldKey1": "generated value 1",
    "fieldKey2": "generated value 2"
  }
}`;
}
