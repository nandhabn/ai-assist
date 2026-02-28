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
  } = context;

  const metaBlock = formatPageMeta(pageMeta);
  const metaSection = metaBlock ? `\n${metaBlock}\n` : "";
  const missionSection = mission
    ? `\nUser Mission: ${mission}\n`
    : "";

  return `You are an expert at predicting user actions on a web page.
Based on the provided context, predict the single most likely next action.
${metaSection}${missionSection}
Current Page Intent: ${pageIntent}
Last Action Taken: ${lastActionLabel || "None"}
Visible Actions: ${JSON.stringify(topVisibleActions)}
Available Form Fields: ${JSON.stringify(formFields)}

Respond in STRICT JSON format with the following structure:
{
  "predictedActionLabel": "string (must be one of the Visible Actions)",
  "reasoning": "string (explain your choice in one sentence)",
  "confidenceEstimate": "number (a value between 0.0 and 1.0)"
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
