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
 * Extracts meaningful keywords from a mission string for fuzzy-matching
 * against element labels. Strips stop words, returns lowercased tokens.
 */
function extractMissionKeywords(mission: string): string[] {
  const STOP_WORDS = new Set([
    "the",
    "and",
    "for",
    "that",
    "this",
    "from",
    "with",
    "page",
    "site",
    "website",
    "official",
    "please",
    "then",
    "into",
    "about",
    "will",
    "can",
    "should",
    "would",
    "could",
    "have",
    "has",
    "had",
    "not",
    "but",
    "its",
    "are",
    "was",
    "were",
    "been",
    "being",
    "find",
    "get",
    "use",
    "make",
    "look",
    "want",
    "need",
  ]);
  return mission
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Strips prompt-injection patterns from user-provided skill text.
 * Removes lines that look like system/role overrides or instruction resets.
 */
function sanitizeSkillText(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase().trim();
      // Block lines that attempt to override system instructions
      return !(
        lower.startsWith("ignore previous") ||
        lower.startsWith("ignore all") ||
        lower.startsWith("disregard") ||
        lower.startsWith("you are now") ||
        lower.startsWith("new instructions:") ||
        lower.startsWith("system:") ||
        lower.startsWith("=== role") ||
        lower.startsWith("=== system") ||
        /^\s*\{?\s*"?role"?\s*:\s*"?system/i.test(lower)
      );
    })
    .join("\n");
}

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
    pageElements,
    currentUrl,
    postActionObservation,
    pageText,
    skills,
    steeringHint,
  } = context;

  const url = currentUrl ?? pageMeta?.url ?? "unknown";
  const title = pageMeta?.title ?? "unknown";

  const missionLine = mission
    ? `MISSION: ${mission}`
    : "MISSION: (none — explore the page)";

  // ── Rich turn history (preferred) ────────────────────────────────────────
  // Show full detail for last 6 turns; summarize older turns compactly.
  let historySection = "";
  if (turnHistory && turnHistory.length > 0) {
    const RECENT_WINDOW = 6;
    const older = turnHistory.slice(0, -RECENT_WINDOW);
    const recent = turnHistory.slice(-RECENT_WINDOW);

    // Compact one-line summaries for older turns
    const olderLines = older.map((t) => {
      const tc = t.toolCall;
      const param =
        tc.params.label ??
        tc.params.url ??
        tc.params.reason ??
        tc.params.direction ??
        "";
      return `  Step ${t.stepNumber}: ${tc.tool}(${param.slice(0, 30)}) → ${t.success ? "ok" : "FAILED"}`;
    });

    const recentLines = recent.map((t) => {
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

    const allLines = [
      ...(olderLines.length > 0
        ? ["(earlier steps — summary)", ...olderLines, ""]
        : []),
      ...recentLines,
    ];

    historySection = [
      "=== SESSION HISTORY (most recent last) ===",
      allLines.join("\n\n"),
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

  // ── Filter out decorative / low-value elements ─────────────────────────────
  // These patterns are almost never mission-relevant and inflate the prompt.
  const DECORATIVE_RE =
    /^(close\s.{15,}|move\s+360|return\s+360|mute\s+volume|full\s+screen|go\s+to\s+current\s+live|play$|pause$)/i;
  const filteredElements =
    pageElements?.filter((e) => !DECORATIVE_RE.test(e.label)) ?? [];

  // ── Mission-relevant element highlights ─────────────────────────────────────
  let relevantSection = "";
  if (mission && filteredElements.length > 0) {
    const keywords = extractMissionKeywords(mission);
    if (keywords.length > 0) {
      const relevant = filteredElements.filter((e) => {
        const lower = e.label.toLowerCase();
        return keywords.some((kw) => lower.includes(kw));
      });
      if (relevant.length > 0 && relevant.length <= 15) {
        relevantSection = [
          "▶ BEST MATCHES for this mission (prefer these):",
          ...relevant.map((e) => {
            const val = e.currentValue
              ? ` (currently: "${e.currentValue}")`
              : "";
            return `  ★ "${e.label}" [${e.type}]${val}`;
          }),
          "",
        ].join("\n");
      }
    }
  }

  // Format page elements grouped by type for readability
  const buttons =
    filteredElements
      .filter((e) => e.type === "button")
      .map((e) => `  • "${e.label}"`)
      .join("\n") ?? "";
  const links =
    filteredElements
      .filter((e) => e.type === "link")
      .map((e) => `  • "${e.label}"`)
      .join("\n") ?? "";
  const inputs =
    filteredElements
      .filter(
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

  // ── Active Skills (filter to mission-relevant only) ────────────────────────
  const missionKeywords = mission ? extractMissionKeywords(mission) : [];
  const relevantSkills =
    skills && skills.length > 0 && missionKeywords.length > 0
      ? skills.filter((s) => {
          const text = `${s.name} ${s.description}`.toLowerCase();
          return missionKeywords.some((kw) => text.includes(kw));
        })
      : (skills ?? []);

  const skillToolNames: string[] = [];
  const skillsSection =
    relevantSkills.length > 0
      ? [
          "=== ACTIVE SKILLS ===",
          "You have the following user-defined skills. ONLY use them when the mission clearly requires their capability.",
          "",
          ...relevantSkills.map((s) => {
            const toolBlock =
              s.tools && s.tools.length > 0
                ? s.tools
                    .map((t) => {
                      skillToolNames.push(t.name);
                      return `  Tool: ${t.name}\n  When to use: ${sanitizeSkillText(t.description)}`;
                    })
                    .join("\n")
                : null;
            return [
              `[${s.name}]`,
              `Description: ${sanitizeSkillText(s.description)}`,
              `Instructions:\n${sanitizeSkillText(s.instructions)
                .split("\n")
                .map((l) => `  ${l}`)
                .join("\n")}`,
              ...(toolBlock ? [`Custom tools:\n${toolBlock}`] : []),
            ].join("\n");
          }),
          "=== END SKILLS ===",
          "",
        ].join("\n")
      : "";

  // Build skillToolLines here so each entry carries the tool's actual description + paramHint
  // (skillToolNames is already populated while building skillsSection above)
  const skillToolLines = skillToolNames.map((n) => {
    // Find the tool across all relevant skills to get description + paramHint
    for (const s of relevantSkills) {
      const t = s.tools?.find((tool) => tool.name === n);
      if (t) {
        const hint = t.paramHint ? ` Params: ${t.paramHint}.` : "";
        return `  ${n.padEnd(22)}— ${sanitizeSkillText(t.description)}${hint}`;
      }
    }
    return `  ${n.padEnd(22)}— Custom skill tool.`;
  });

  const steeringSection = steeringHint
    ? [
        "=== USER STEERING (ONE-TIME OVERRIDE) ===",
        `The user has typed the following instruction RIGHT NOW. Treat it as the highest-priority directive for THIS step only. After acting on it, resume normal mission execution.`,
        `  ▶ ${steeringHint}`,
        "=== END STEERING ===",
        "",
      ].join("\n")
    : "";

  return [
    "=== ROLE ===",
    "You are an autonomous web agent executing a mission step-by-step.",
    "First, identify which element in the INTERACTIVE ELEMENTS list best advances the mission.",
    "Then choose the ONE tool call to interact with it.",
    "",
    steeringSection,
    "=== MISSION ===",
    missionLine,
    "",
    "=== CURRENT PAGE ===",
    `Title      : ${title}`,
    `URL        : ${url}`,
    `Page Intent: ${pageIntent}`,
    "",
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
    relevantSection,
    elementsSection || "(no interactive elements detected)",
    "",
    "=== AVAILABLE TOOLS ===",
    "  navigate(url)         — Go to a full URL. Use whenever you need a different site or page.",
    "  click(label)          — Click a button or link. The label MUST closely match one of the elements listed above.",
    "  type(label, text)     — Type 'text' into an input or textarea. 'label' is optional: omit it (leave empty) when a click just focused the target field — the text will go straight into the active element.",
    "  fill_form(fields)     — Fill multiple form fields in one step. 'fields' is a JSON object mapping each field's visible label (or aria-label / placeholder / name) to the value to enter. Handles text inputs, textareas, <select> dropdowns, checkboxes (use \"true\"/\"false\"), and radio buttons. Prefer this over multiple type() calls when filling a whole form.",
    "  scroll(direction)     — Scroll 'up' or 'down' to reveal off-screen content.",
    "  message(message)      — Display a short status update to the user (key milestones only).",
    "  done(reason)          — Signal the mission is complete or unrecoverable.",
    ...skillToolLines,
    "",
    "=== TOOL SELECTION RULES ===",
    "  1. Call navigate() whenever you need to reach a different website or URL — do NOT look for a URL bar on-page.",
    '  2. Call click() for buttons and links. The "label" MUST be an EXACT string copied from the INTERACTIVE ELEMENTS list above — do NOT paraphrase, abbreviate, or invent labels.',
    "  3. Call type() for single text inputs. Use fill_form() instead when filling two or more fields.",
    "  3b. Call fill_form() to fill an entire form at once — pass all fields as a single \"fields\" object. For checkboxes use \"true\" or \"false\". For selects / radios use the exact option text.",
    "  4. Call done() ONLY when the page displays an explicit success: thank-you message, order confirmation, or order number.",
    "  5. NEVER call done() just because you found, clicked, or viewed a product. The mission is only complete after checkout confirmation.",
    "  6. If a sidebar or panel just opened, you are NOT done — look for 'Visit site', 'Buy', 'Add to cart', or 'Checkout' actions inside it.",
    "  7. Call message() to surface important findings (e.g. prices, product details) before navigating away from a result page.",
    "  8. NEVER repeat an action that already appears in SESSION HISTORY as successfully executed on the current page.",
    "  9. Consult RESULT OF LAST ACTION (when present) to understand exactly what changed on the page before deciding the next step.",
    "  10. When BEST MATCHES are listed, prefer those elements unless they clearly don't fit the current step.",
    "",
    "=== OUTPUT FORMAT ===",
    "Respond with ONLY a valid JSON object. No markdown fences, no extra keys, no commentary.",
    "Include ONLY the params relevant to the chosen tool:",
    `  navigate   → { "url": "<full URL>" }`,
    `  click      → { "label": "<EXACT string from INTERACTIVE ELEMENTS>" }`,
    `  type       → { "label": "<input label or empty>", "text": "<text to type>" }`,
    `  fill_form  → { "fields": { "<field label>": "<value>", "<field label 2>": "<value 2>" } }`,
    `  scroll     → { "direction": "up" | "down" }`,
    `  message    → { "message": "<short status>" }`,
    `  done       → { "reason": "<why complete or unrecoverable>" }`,
    "",
    "{",
    `  "tool": "navigate | click | type | fill_form | scroll | message | done${skillToolNames.length > 0 ? ` | ${skillToolNames.join(" | ")}` : ""}",`,
    '  "params": { <see per-tool params above> },',
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
