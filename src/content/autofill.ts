/**
 * AI-powered form autofill data generation.
 */

import type { FormFieldInfo } from "@/types/ai";
import { state } from "./state";
import { aiLog, canMakeAICall, recordAICall, AI_MAX_CALLS_PER_WINDOW, AI_MIN_INTERVAL, getRLState } from "./rateLimit";
import { getAIProvider } from "./providers";

// ─── AI-powered generator ─────────────────────────────────────────────────────

/**
 * Generates autofill data using AI. Falls back to basic generated data
 * if AI is unavailable or the call fails.
 */
export async function generateAutofillData(
  fields: FormFieldInfo[],
  retryContext?: {
    fieldErrors: { fieldId: string; fieldName: string; errorText: string }[];
  },
): Promise<Record<string, string>> {
  if (state.isAutofillGenerating) {
    console.log("[Flow Agent] Autofill generation already in progress, waiting...");
    return state.cachedAutofillData || generateBasicFormData(fields);
  }

  const fieldsKey = fields.map((f) => `${f.name}|${f.id}|${f.type}`).join(";");

  if (retryContext?.fieldErrors.length) {
    state.cachedAutofillData = null;
    state.cachedAutofillFieldsKey = null;
  }

  if (state.cachedAutofillData && state.cachedAutofillFieldsKey === fieldsKey) {
    console.log("[Flow Agent] Returning cached AI form data");
    return state.cachedAutofillData;
  }

  if (state.aiProvider === undefined) {
    state.aiProvider = getAIProvider();
  }

  if (state.aiProvider && canMakeAICall()) {
    state.isAutofillGenerating = true;
    try {
      aiLog(`Form data AI call triggered | Fields: ${fields.length} | Page: ${document.title || window.location.pathname}`);
      recordAICall();
      console.log("[Flow Agent] Requesting AI-generated form data...");

      const pageContext = document.title || window.location.pathname;
      const missionPrefix = state.currentMission ? `User mission: ${state.currentMission}. ` : "";
      const enrichedContext = retryContext?.fieldErrors.length
        ? `${missionPrefix}${pageContext}. Previous fill attempt had validation errors — please correct: ` +
          retryContext.fieldErrors.map((e) => `"${e.fieldName || e.fieldId}": ${e.errorText}`).join("; ")
        : `${missionPrefix}${pageContext}`;

      const result = await state.aiProvider.generateFormData(fields, enrichedContext);

      if (result.fieldValues && Object.keys(result.fieldValues).length > 0) {
        aiLog(`Form data AI call SUCCESS | Fields generated: ${Object.keys(result.fieldValues).length}`);
        console.log("[Flow Agent] AI-generated form data received:", result.fieldValues);

        const expandedData: Record<string, string> = {};
        for (const field of fields) {
          const identifiers = [field.name, field.id, field.labelText, field.ariaLabel, field.placeholder].filter(Boolean);
          let value: string | undefined;

          for (const key of identifiers) {
            if (result.fieldValues[key]) { value = result.fieldValues[key]; break; }
          }

          if (!value) {
            const normalize = (s: string) => (s || "").toLowerCase().replace(/[\s_-]/g, "");
            for (const key of identifiers) {
              const normKey = normalize(key);
              for (const [aiKey, aiVal] of Object.entries(result.fieldValues)) {
                if (normalize(aiKey) === normKey) { value = aiVal; break; }
              }
              if (value) break;
            }
          }

          if (!value) continue;

          // Single canonical key: id → name → labelText → ariaLabel → placeholder
          const canonicalKey = field.id || field.name || field.labelText || field.ariaLabel || field.placeholder;
          if (canonicalKey) expandedData[canonicalKey] = value;
        }

        state.cachedAutofillData = expandedData;
        state.cachedAutofillFieldsKey = fieldsKey;
        return expandedData;
      }
    } catch (error) {
      aiLog(`Form data AI call FAILED | Error: ${error}`);
      console.warn("[Flow Agent] AI form data generation failed, falling back to basic generator:", error);
    } finally {
      state.isAutofillGenerating = false;
    }
  } else if (!state.aiProvider) {
    aiLog("Form data AI call SKIPPED (no provider configured)");
    console.log("[Flow Agent] No AI provider available, using basic data generator");
  } else {
    const s = getRLState();
    aiLog(
      `Form data AI call SKIPPED (rate limited) | Calls this window: ${s.count}/${AI_MAX_CALLS_PER_WINDOW} | Cooldown remaining: ${Math.max(0, Math.round((AI_MIN_INTERVAL - (Date.now() - s.lastCall)) / 1000))}s`,
    );
    console.log("[Flow Agent] AI rate limited, using basic data generator");
  }

  const fallback = generateBasicFormData(fields);
  state.cachedAutofillData = fallback;
  state.cachedAutofillFieldsKey = fieldsKey;
  return fallback;
}

// ─── Basic fallback generator ─────────────────────────────────────────────────

/**
 * Generates simple test data based on field type heuristics (no AI needed).
 */
export function generateBasicFormData(fields: FormFieldInfo[]): Record<string, string> {
  const data: Record<string, string> = {};
  const normalize = (str: string) => (str || "").toLowerCase().replace(/[\s_-]/g, "");
  const randomString = (len: number) => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  };

  const firstName = "Alex";
  const lastName = "Johnson";
  const email = `alex.johnson${Math.floor(Math.random() * 1000)}@example.com`;
  const password = `Test!${randomString(8)}#1`;
  const phone = `+1-555-${Math.floor(Math.random() * 900 + 100)}-${Math.floor(Math.random() * 9000 + 1000)}`;

  for (const field of fields) {
    const hints = [field.name, field.id, field.placeholder, field.labelText, field.ariaLabel]
      .map(normalize)
      .join(" ");
    const type = field.type.toLowerCase();

    let value = "";
    if (field.options && field.options.length > 0) value = field.options[0];
    else if (type === "email" || hints.includes("email")) value = email;
    else if (type === "password" || hints.includes("password")) value = password;
    else if (type === "tel" || hints.includes("phone") || hints.includes("mobile")) value = phone;
    else if (hints.includes("firstname") || hints.includes("first")) value = firstName;
    else if (hints.includes("lastname") || hints.includes("last")) value = lastName;
    else if (hints.includes("name")) value = `${firstName} ${lastName}`;
    else if (type === "number") value = String(Math.floor(Math.random() * 10000));
    else if (type === "date") value = "1990-06-15";
    else value = `Test ${randomString(6)}`;

    if (!value) continue;

    const identifiers = [field.name, field.id, field.labelText, field.ariaLabel, field.placeholder].filter(Boolean);
    for (const id of identifiers) { data[id] = value; }
    if (identifiers.length === 0) { data[`field_${type}_${fields.indexOf(field)}`] = value; }
  }

  return data;
}
