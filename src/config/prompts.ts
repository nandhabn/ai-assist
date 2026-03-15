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
  "You are an expert web automation agent.\n" +
  "Your task: observe the current page state and predict the single best next action to take.\n" +
  "When a mission is provided, every action you choose MUST directly advance that mission — not just be related to it.\n" +
  "Output ONLY a valid JSON object that matches the schema provided — no markdown, no extra keys, no commentary.";

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

  const historyLines =
    stepHistory && stepHistory.length > 0
      ? stepHistory
          .slice(-8)
          .map((s, i) => `  ${i + 1}. ${s.action} (on ${s.pageUrl})`)
          .join("\n")
      : "";

  const planSection = plan
    ? [
        "=== MISSION PLAN ===",
        plan,
        `▶ EXECUTE PLAN STEP ${currentPlanStep ?? 1} NOW`,
        "  Your chosen action MUST advance this plan step.",
        "  If this step requires a different site, select the URL bar, address input, or the closest navigation action.",
        "=== END PLAN ===",
        "",
      ].join("\n")
    : "";

  const historySection = historyLines
    ? ["=== SESSION HISTORY (most recent last) ===", historyLines, ""].join(
        "\n",
      )
    : "";

  return [
    "=== ROLE ===",
    "You are an expert web automation agent. Predict the single best next action on this web page.",
    "",
    "=== MISSION ===",
    mission ||
      "(none — select the most logical next step based on page context)",
    "",
    "=== CURRENT PAGE STATE ===",
    metaBlock || "(no page metadata available)",
    `Page Intent : ${pageIntent}`,
    `Last Action : ${lastActionLabel || "None"}`,
    "",
    planSection,
    historySection,
    "=== INTERACTIVE ELEMENTS ===",
    "Visible Actions — your answer MUST be one of these exact strings:",
    JSON.stringify(topVisibleActions, null, 2),
    "",
    "Available Form Fields:",
    JSON.stringify(formFields, null, 2),
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "{",
    '  "predictedActionLabel": "<string — MUST exactly match one of the Visible Actions listed above>",',
    '  "reasoning": "<string — one short phrase, max 60 chars, e.g. \'advances mission goal\'>",',
    '  "confidenceEstimate": <number between 0.0 (no confidence) and 1.0 (certain)>,',
    '  "inputText": "<string — ONLY include when the chosen action is to TYPE text; provide the exact text to type, e.g. \'iphone 17 pro\'. OMIT this key entirely for click and navigation actions.>"',
    "}",
  ].join("\n");
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
  return [
    "=== ROLE ===",
    "You are an autonomous web agent. Before executing, you must produce a clear step-by-step action plan for the mission.",
    "",
    "=== MISSION ===",
    mission,
    "",
    "=== CURRENT PAGE ===",
    `Title : ${pageTitle}`,
    `URL   : ${pageUrl}`,
    "",
    "=== VISIBLE ACTIONS ON THIS PAGE ===",
    visibleActions.slice(0, 20).join(", "),
    "",
    "=== PLANNING RULES ===",
    "1. Produce a numbered list of concrete browser actions — maximum 10 steps.",
    "2. Each step must specify a precise action: click <element>, type <text> into <field>, navigate to <url>, etc.",
    "3. Ground each step in the visible actions or known URLs — do not invent elements that may not exist.",
    "4. If the mission spans multiple pages, include explicit navigation steps.",
    "5. The final step MUST be a Verify step that confirms the mission succeeded (e.g. 'Verify: order confirmation page shows order number').",
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "{",
    '  "plan": "1. ...\\n2. ...\\n3. ... (newline-separated numbered steps)",',
    '  "estimatedSteps": <integer — total number of steps in the plan>',
    "}",
  ].join("\n");
}

// ─── Agent-Mode Prediction Prompts ────────────────────────────────────────────

/** System message used for agent-mode prediction (always uses AI). */
export const AGENT_PREDICTION_SYSTEM_PROMPT =
  "You are an autonomous web agent executing a multi-step mission on behalf of the user.\n" +
  "At every step you receive the current page state and must output EXACTLY ONE tool call as a JSON object.\n" +
  "————————————————————————————————————————————————————————————————\n" +
  "=== TOOL CALL FORMAT ===\n" +
  "Output a single raw JSON object — no markdown, no extra keys:\n" +
  '{ "tool": "navigate|click|type|scroll|message|done", "params": { ... }, "reasoning": "<= 60 chars", "confidenceEstimate": 0.0 }\n' +
  "————————————————————————————————————————————————————————————————\n" +
  "=== AVAILABLE TOOLS ===\n" +
  "  navigate(url)         — Go to a full URL. Use this whenever you need to reach a different site or page.\n" +
  "  click(label)          — Click a button or link. The label MUST match an element currently visible on the page.\n" +
  "  type(label, text)     — Type text into an input or textarea. If a click just focused the field, omit 'label' and the text will go into the active element.\n" +
  "  scroll(direction)     — Scroll 'up' or 'down' to reveal off-screen content.\n" +
  "  message(message)      — Display a short status update to the user. Use SPARINGLY — only for important milestones visible to the user (e.g. 'Item added to cart'). NEVER use message() to verify, confirm, or narrate your own plan steps.\n" +
  "  done(reason)          — Signal mission complete or unrecoverable ONLY after an explicit on-screen confirmation.\n" +
  "————————————————————————————————————————————————————————————————\n" +
  "=== STRICT RULES ===\n" +
  "  1. Always choose the tool that DIRECTLY advances the mission — never a no-op.\n" +
  "  2. If the last action FAILED (marked ⚠), choose a DIFFERENT label, tool, or approach. Never repeat the same failed action.\n" +
  "  3. Never call done() just because you found, clicked, or viewed a product. Wait for an order/checkout confirmation message.\n" +
  "  4. Never call scroll() more than 3 consecutive times without clicking something.\n" +
  "  5. Never repeat an action already in SESSION HISTORY as successfully executed on the current page.\n" +
  "  6. NEVER call message() to verify you are on the right page, confirm a plan step, or narrate progress. Use it only when you have a concrete result to report to the user.\n" +
  "  7. NEVER call message() twice in a row. If your previous action was message(), your next action MUST be click, type, navigate, scroll, or done.\n" +
  "  8. Output raw JSON ONLY — no markdown fences, no explanatory text outside the JSON object.\n" +
  "————————————————————————————————————————————————————————————————";

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

  const historyBlock =
    stepHistory.length > 0
      ? stepHistory
          .slice(-10)
          .map((s, i) => `  ${i + 1}. ${s.action} (on ${s.pageUrl})`)
          .join("\n")
      : "";

  return [
    "=== ROLE ===",
    "You are an autonomous web agent executing a multi-step mission. Choose the single best next action.",
    "",
    "=== MISSION ===",
    mission || "(none — explore the page and take the most logical action)",
    "",
    "=== CURRENT PAGE STATE ===",
    metaBlock || "(no page metadata available)",
    `Page Intent : ${pageIntent}`,
    `Last Action : ${lastActionLabel || "None"}`,
    "",
    historyBlock
      ? [
          "=== SESSION HISTORY (most recent last) ===",
          historyBlock.trim(),
          "",
        ].join("\n")
      : "",
    "=== INTERACTIVE ELEMENTS ===",
    "Visible Actions — your answer MUST be one of these exact strings, or 'MISSION_COMPLETE':",
    JSON.stringify(topVisibleActions, null, 2),
    "",
    "Available Form Fields:",
    JSON.stringify(formFields, null, 2),
    "",
    "=== COMPLETION CONDITION ===",
    "If the page shows an explicit success message, order confirmation, or the mission goal is fully achieved,",
    "set confidenceEstimate to 0.0 and predictedActionLabel to 'MISSION_COMPLETE'.",
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "{",
    '  "predictedActionLabel": "<string — one of the Visible Actions above, or \'MISSION_COMPLETE\' if done>",',
    '  "reasoning": "<string — one phrase, max 60 chars, e.g. \'next step toward goal\'>",',
    '  "confidenceEstimate": <number — 0.0 signals MISSION_COMPLETE; 0.01 to 1.0 is confidence in the chosen action>,',
    '  "inputText": "<string — ONLY include when the action is to TYPE text; provide exact text to type. OMIT for click/navigation.>"',
    "}",
  ].join("\n");
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
    pageText,
    skills,
  } = context;

  const url = currentUrl ?? pageMeta?.url ?? "unknown";
  const title = pageMeta?.title ?? "unknown";

  const missionLine = mission
    ? `MISSION: ${mission}`
    : "MISSION: (none — explore the page)";

  const planSection = plan
    ? [
        "",
        "=== MISSION PLAN ===",
        plan,
        "",
        `▶ EXECUTE STEP ${currentPlanStep ?? 1} NOW`,
        "  Your tool call MUST advance this plan step.",
        "  If this step requires a different site, call navigate(url) immediately.",
        "=== END PLAN ===",
        "",
      ].join("\n")
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
      if (tc.reasoning)
        decisionLine += `\n  Reasoning: ${tc.reasoning.slice(0, 80)}`;

      let resultLine = `  Outcome: ${t.success ? "success" : "FAILED"}`;
      if (t.observation) {
        const obs = t.observation;
        const parts: string[] = [];
        if (obs.failureReason) parts.push(`reason: ${obs.failureReason}`);
        if (obs.urlChanged)
          parts.push(
            `navigated from ${obs.previousUrl.replace(/^https?:\/\//, "").slice(0, 40)}`,
          );
        if (obs.newElements.length > 0)
          parts.push(
            `+${obs.newElements.length} new elements (${obs.newElements
              .slice(0, 3)
              .map((l) => `"${l}"`)
              .join(", ")}${obs.newElements.length > 3 ? "…" : ""})`,
          );
        if (obs.removedElements.length > 0)
          parts.push(`-${obs.removedElements.length} removed`);
        if (parts.length > 0) resultLine += ": " + parts.join(" | ");
      }

      return `Step ${t.stepNumber} — ${pageShort}\n${decisionLine}\n${resultLine}`;
    });
    historySection = [
      "=== SESSION HISTORY (most recent last) ===",
      turnLines.join("\n\n"),
      "",
    ].join("\n");
  } else if (stepHistory && stepHistory.length > 0) {
    // Lightweight fallback
    const lines = stepHistory
      .slice(-6)
      .map((s, i) => {
        const action = s.action.slice(0, 60);
        const u = s.pageUrl.replace(/^https?:\/\//, "").slice(0, 50);
        return `  ${i + 1}. ${action}  [${u}]`;
      })
      .join("\n");
    historySection = [
      "=== SESSION HISTORY (most recent last) ===",
      lines,
      "",
    ].join("\n");
  }

  // ── Post-action DOM observation ───────────────────────────────────────────
  let observationSection = "";
  if (postActionObservation) {
    const obs = postActionObservation;
    const lines: string[] = [];

    // Surface failures at the top so the AI registers them immediately
    if (obs.failureReason) {
      lines.push(`  ⚠ LAST ACTION FAILED: ${obs.failureReason}`);
      lines.push(
        `  → Do NOT repeat the same action. Try a different label, scroll to reveal the element, or use 'navigate' if needed.`,
      );
    }

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
      const header = obs.failureReason
        ? "=== RESULT OF LAST ACTION — FAILED (recovery required) ==="
        : "=== RESULT OF LAST ACTION (DOM re-evaluated) ===";
      observationSection = [header, ...lines, ""].join("\n");
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

  // ── Active Skills ─────────────────────────────────────────────────────────
  const skillToolNames: string[] = [];
  const skillsSection =
    skills && skills.length > 0
      ? [
          "=== ACTIVE SKILLS ===",
          "You have the following user-defined skills. Apply their instructions when relevant to the current step.",
          "",
          ...skills.map((s) => {
            const toolBlock =
              s.tools && s.tools.length > 0
                ? s.tools.map((t) => {
                    skillToolNames.push(t.name);
                    return `  Tool: ${t.name}\n  When to use: ${t.description}`;
                  }).join("\n")
                : null;
            return [
              `[${s.name}]`,
              `Description: ${s.description}`,
              `Instructions:\n${s.instructions.split("\n").map((l) => `  ${l}`).join("\n")}`,
              ...(toolBlock ? [`Custom tools:\n${toolBlock}`] : []),
            ].join("\n");
          }),
          "=== END SKILLS ===",
          "",
        ].join("\n")
      : "";

  // Extra tool entries from skills
  const skillToolLines = skillToolNames.map(
    (n) => `  ${n.padEnd(22)}— Custom skill tool. Call when its description matches your intent.`,
  );

  return [
    "=== ROLE ===",
    "You are an autonomous web agent executing a mission step-by-step. Choose ONE tool call that advances the mission.",
    "",
    "=== MISSION ===",
    missionLine,
    "",
    "=== CURRENT PAGE ===",
    `Title      : ${title}`,
    `URL        : ${url}`,
    `Page Intent: ${pageIntent}`,
    "",
    planSection,
    observationSection,
    historySection,
    skillsSection,
    pageText
      ? [
          "=== VISIBLE PAGE CONTENT (read-only context) ===",
          "  NOTE: These are informational text snippets scraped from the page.",
          "  They are NOT interactive element labels. Do NOT use them as the 'label'",
          "  parameter in click() or type() calls. Use the INTERACTIVE ELEMENTS section for that.",
          ...pageText.split(" | ").map((item) => `  • ${item.trim()}`),
          "",
        ].join("\n")
      : "",
    "=== INTERACTIVE ELEMENTS ===",
    elementsSection || "(no interactive elements detected)",
    "",
    "=== AVAILABLE TOOLS ===",
    "  navigate(url)         — Go to a full URL. Use whenever you need a different site or page.",
    "  click(label)          — Click a button or link. The label MUST closely match one of the elements listed above.",
    "  type(label, text)     — Type 'text' into an input or textarea. 'label' is optional: omit it (leave empty) when a click just focused the target field — the text will go straight into the active element.",
    "  scroll(direction)     — Scroll 'up' or 'down' to reveal off-screen content.",
    "  message(message)      — Display a short status update to the user (key milestones only).",
    "  done(reason)          — Signal the mission is complete or unrecoverable.",
    ...skillToolLines,
    "",
    "=== TOOL SELECTION RULES ===",
    "  1. Call navigate() whenever you need to reach a different website or URL — do NOT look for a URL bar on-page.",
    "  2. Call click() for buttons and links. The label MUST closely match a listed element above.",
    "  3. Call type() for text inputs, search boxes, and dropdowns. Provide the exact text to enter.",
    "  4. Call done() ONLY when the page displays an explicit success: thank-you message, order confirmation, or order number.",
    "  5. NEVER call done() just because you found, clicked, or viewed a product. The mission is only complete after checkout confirmation.",
    "  6. If a sidebar or panel just opened, you are NOT done — look for 'Visit site', 'Buy', 'Add to cart', or 'Checkout' actions inside it.",
    "  7. Call message() to surface important findings (e.g. prices, product details) before navigating away from a result page.",
    "  8. NEVER repeat an action that already appears in SESSION HISTORY as successfully executed on the current page.",
    "  9. If the plan step requires a site you are not currently on, call navigate() immediately.",
    " 10. Consult RESULT OF LAST ACTION (when present) to understand exactly what changed on the page before deciding the next step.",
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "{",
    `  "tool": "navigate | click | type | scroll | message | done${skillToolNames.length > 0 ? ` | ${skillToolNames.join(" | ")}` : ""}",`,
    '  "params": {',
    '    "url"      : "<string — navigate only: full URL to navigate to>",',
    '    "label"    : "<string — click: required, must match a listed element above | type: optional, omit if a click just focused the target input>",',
    '    "text"     : "<string — type only: exact text to type into the field>",',
    '    "direction": "up | down  (scroll only)",',
    '    "message"  : "<string — message only: short status update for the user>",',
    '    "reason"   : "<string — done only: brief explanation of why the mission is complete or unrecoverable>"',
    "  },",
    '  "planStep": <integer — the plan step number (from the MISSION PLAN above) this action is advancing>,',
    '  "reasoning": "<string — max 60 chars explaining why this tool was chosen>",',
    '  "confidenceEstimate": <number between 0.0 and 1.0>',
    "}",
  ].join("\n");
}

// ─── Form Data Generation Prompts ─────────────────────────────────────────────

/** System message used by ChatGPT API for form-data generation calls. */
export const FORM_DATA_SYSTEM_PROMPT =
  "You are a test data generator that produces realistic, coherent form data for web automation.\n" +
  "All generated values for a single request must belong to the same consistent persona (same name, address, email, etc.).\n" +
  "Output ONLY a valid JSON object matching the exact schema provided — no markdown, no extra keys, no commentary.";

/**
 * User prompt for generating realistic test data for form fields.
 * Used by all three providers.
 */
export function buildFormDataPrompt(
  fieldDescriptions: string,
  pageContext?: string,
): string {
  return [
    "=== ROLE ===",
    "You are a test data generator for web form automation.",
    "Generate realistic, contextually appropriate, and internally coherent test data for the form fields below.",
    "",
    "=== PAGE CONTEXT ===",
    pageContext || "(none provided)",
    "",
    "=== FORM FIELDS ===",
    fieldDescriptions,
    "",
    "=== GENERATION RULES ===",
    "1. Use a single consistent persona across all fields (same name, address, email, phone, etc.).",
    "2. Email addresses MUST use @example.com or @test.com domains only.",
    "3. Passwords MUST be strong: 12+ characters, mixed uppercase and lowercase, at least one number, at least one symbol.",
    "4. Phone numbers MUST use a valid format for the detected locale (default: US +1 format).",
    "5. For select, dropdown, or radio button fields with listed options, you MUST choose exactly one of the provided option strings verbatim — do not invent new values.",
    "6. Use the field's 'name' attribute as the response key. If 'name' is empty, use 'id'. If both are empty, use 'label' or 'aria-label'.",
    "7. If the page context begins with 'User mission:', tailor the generated values to directly fulfill that mission.",
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "{",
    '  "fieldValues": {',
    '    "<fieldKey1>": "<generated value 1>",',
    '    "<fieldKey2>": "<generated value 2>"',
    "  }",
    "}",
  ].join("\n");
}
