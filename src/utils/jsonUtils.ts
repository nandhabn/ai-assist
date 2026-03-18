/**
 * Shared JSON parsing utilities for AI provider responses.
 *
 * Handles the common failure modes across all LLM providers:
 *   1. Markdown code fences (```json ... ```)
 *   2. Prose preamble before the JSON object
 *   3. Truncated / incomplete JSON (unterminated strings, missing brackets)
 */

/**
 * Extracts a JSON string from an LLM response that may be wrapped in
 * markdown fences or surrounded by prose.
 *
 * @param content  Raw response text from the AI provider.
 * @returns        The extracted JSON substring.
 * @throws         If no JSON object or array can be found.
 */
export function extractJson(content: string): string {
  let text = content.trim();

  // Strip markdown code fences
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Also handle inline fences that aren't the entire string
  const inlineFence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (inlineFence) return inlineFence[1].trim();

  // Find the first '{' or '[' and the matching last '}' or ']'
  const jsonStart = text.search(/[{[]/);
  if (jsonStart === -1) {
    throw new Error("No JSON object or array found in AI response.");
  }

  const startChar = text[jsonStart];
  const endChar = startChar === "{" ? "}" : "]";
  const lastEnd = text.lastIndexOf(endChar);

  if (lastEnd === -1 || lastEnd < jsonStart) {
    throw new Error("No JSON object or array found in AI response.");
  }

  return text.substring(jsonStart, lastEnd + 1);
}

/**
 * Parses an AI response string into `T`, handling the common LLM quirks:
 *
 *   - Markdown code fences (`\`\`\`json ... \`\`\``)
 *   - Prose preamble before the JSON (e.g. "Here is the result:\n{...}")
 *   - Truncated output (unterminated strings, missing closing braces/brackets)
 *
 * On truncation, the parser attempts a best-effort repair by closing open
 * strings and balancing braces/brackets before retrying.
 *
 * @param raw  The raw response text from the AI provider.
 * @returns    The parsed object of type `T`.
 * @throws     The original `JSON.parse` error if repair also fails.
 */
export function safeJsonParse<T>(raw: string): T {
  // 1. Strip markdown code fences
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // 2. Strip any prose preamble before the first '{' or '['
  const firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) text = text.slice(firstBrace).trim();

  // 3. Try a clean parse first
  try {
    return JSON.parse(text) as T;
  } catch (firstErr) {
    // 4. Attempt truncation repair for truncated/incomplete JSON
    const msg = (firstErr as Error).message ?? "";
    const isTruncation =
      msg.includes("Unterminated") ||
      msg.includes("Unexpected end") ||
      msg.includes("Expected property name") ||
      msg.includes("Unexpected token");
    if (!isTruncation) {
      throw firstErr;
    }

    let repaired = text;

    // Close any open string (count unescaped quotes)
    const quoteCount = (repaired.match(/(?<!\\)"/g) ?? []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    // If the text ends with a bare ":" (missing value), insert null
    if (/:\s*$/.test(repaired)) repaired += "null";

    // Close any open objects/arrays by scanning the bracket stack
    const stack: string[] = [];
    for (const ch of repaired) {
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
    repaired += stack.reverse().join("");

    try {
      const result = JSON.parse(repaired) as T;
      console.warn("[safeJsonParse] Repaired truncated JSON successfully.");
      return result;
    } catch {
      // Re-throw the original error so callers see the real problem
      throw firstErr;
    }
  }
}
