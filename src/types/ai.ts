// src/types/ai.ts

/**
 * Metadata describing a single form field, used for AI-powered data generation.
 */
export interface FormFieldInfo {
  name: string;
  id: string;
  type: string;
  placeholder: string;
  labelText: string;
  ariaLabel: string;
  /** Available options for select/dropdown and radio group fields (excludes empty/placeholder options). */
  options?: string[];
}

/**
 * The structured response from AI when generating form fill data.
 */
export interface AIFormData {
  /**
   * A mapping of field identifiers (name, id, label, or aria-label) to generated values.
   * Each key should correspond to one of the fields described in the request.
   */
  fieldValues: Record<string, string>;
}

/**
 * Defines the standard interface for an AI prediction provider.
 * This abstraction allows for swapping different AI backends (e.g., Gemini, Amazon Nova)
 * without changing the core application logic.
 */
export interface AIProvider {
  /**
   * Takes a compact representation of the page context and returns a predicted next action.
   * @param context A lightweight summary of the current page state.
   * @returns A promise that resolves to an AIPrediction object.
   */
  predictNextAction(context: CompactContext): Promise<AIPrediction>;

  /**
   * Generates realistic test data for a set of form fields using AI.
   * The AI analyzes field names, types, labels, and placeholders to produce
   * contextually appropriate values (e.g., real-looking emails, names, addresses).
   * @param fields Array of form field metadata describing each field.
   * @param pageContext Optional string describing the page context (e.g., "signup form", "checkout").
   * @returns A promise that resolves to an AIFormData object with generated values.
   */
  generateFormData(
    fields: FormFieldInfo[],
    pageContext?: string,
  ): Promise<AIFormData>;

  /**
   * Agent tool-calling interface.
   * Instead of label-matching predictions, the AI picks a typed tool with explicit
   * parameters (navigate, click, type, scroll, done). This eliminates the fragile
   * fuzzy label-to-selector matching used by predictNextAction.
   *
   * @param context The compact page context including rendered elements.
   * @returns A structured AgentToolCall describing exactly what the agent should do.
   */
  callAgentTool?(context: CompactContext): Promise<AgentToolCall>;
}

// ─── Agent Tool-Call Types ────────────────────────────────────────────────────

/**
 * The set of tools the AI agent can invoke.
 *
 * - navigate  Go directly to a URL (plan step 1 or whenever a page change is needed).
 * - click     Click an element identified by its visible label or aria-label.
 * - type      Focus an input/textarea by label and type text into it.
 * - scroll    Scroll the viewport up or down to reveal more content.
 * - done      Signal that the mission is complete (success or unrecoverable failure).
 */
export type AgentToolName = "navigate" | "click" | "type" | "scroll" | "done";

/**
 * Parameters for each tool.  Only the relevant keys need to be set.
 */
export interface AgentToolParams {
  /** navigate: the full URL to visit. */
  url?: string;
  /** click / type: the visible text label, aria-label, or placeholder of the target element. */
  label?: string;
  /** type: the exact text to type. */
  text?: string;
  /** scroll: "up" or "down". */
  direction?: "up" | "down";
  /** done: short human-readable reason (success message or failure explanation). */
  reason?: string;
}

/**
 * A single structured action the AI agent wants to perform.
 * Returned by AIProvider.callAgentTool().
 */
export interface AgentToolCall {
  /** Which tool to invoke. */
  tool: AgentToolName;
  /** Parameters for the tool. */
  params: AgentToolParams;
  /** One-line reasoning for this tool choice (for logging/debugging). */
  reasoning: string;
  /** Confidence in this tool call, 0.0–1.0. */
  confidenceEstimate: number;
}

/**
 * A brief descriptor for a single interactive element on the page.
 * Included in the agent tool prompt so the AI knows what is clickable/typeable.
 */
export interface AgentPageElement {
  /** The primary human-readable label (textContent, aria-label, placeholder, etc.). */
  label: string;
  /** Element type category. */
  type: "button" | "link" | "input" | "select" | "textarea" | "other";
  /** For inputs, selects, and textareas — the value currently typed/selected, if any. */
  currentValue?: string;
}

/**
 * Key metadata extracted from the page's <head> for richer AI context.
 */
export interface PageMeta {
  url: string;
  title: string;
  description: string;
  ogType: string;
  ogSiteName: string;
  keywords: string;
  canonical: string;
}

/**
 * Full record of one agent turn: the page state the AI observed, the tool call
 * it returned, the DOM observation from the action before this one, and the
 * outcome. Stored in AgentSession.turns[] and sent to the AI as rich history.
 */
export interface AgentTurn {
  stepNumber: number;
  pageUrl: string;
  pageTitle: string;
  /** Visible interactive elements the AI saw at decision time (up to 40). */
  elementsSnapshot: AgentPageElement[];
  /** The tool call the AI decided to make. */
  toolCall: AgentToolCall;
  /** DOM diff that was visible to the AI before it made this decision (null for step 1). */
  observation: PostActionObservation | null;
  /** Whether the tool call was executed successfully. */
  success: boolean;
  timestamp: number;
}

/**
 * Summarises what changed on the DOM / page after the previous agent action.
 * Built by diffing the pre-action DOM snapshot against the current DOM state
 * so the AI knows the concrete result of its last action.
 */
export interface PostActionObservation {
  /** True when the page URL changed as a result of the action. */
  urlChanged: boolean;
  /** True when the document title changed. */
  titleChanged: boolean;
  /** Labels of interactive elements that were NOT present before the action. */
  newElements: string[];
  /** Labels of interactive elements that were present before but have since disappeared. */
  removedElements: string[];
  /** The URL the page was on just before the action was executed. */
  previousUrl: string;
}

/**
 * A compact, serializable representation of the current page context,
 * designed to be minimal for efficient API calls.
 */
export interface CompactContext {
  /**
   * The inferred or explicit goal of the current page (e.g., "login", "search_results").
   */
  pageIntent: string;
  /**
   * The label or identifier of the last action the user took.
   */
  lastActionLabel?: string;
  /**
   * A list of labels for the most prominent, visible, and actionable elements on the page.
   */
  topVisibleActions: string[];
  /**
   * A list of labels or identifiers for available form fields.
   */
  formFields: string[];
  /**
   * Key metadata extracted from the page's meta tags, OG tags, etc.
   */
  pageMeta?: PageMeta;
  /**
   * An optional user-defined mission/goal that guides AI predictions and form data generation.
   * Set via the Mission Prompt panel in the extension.
   */
  mission?: string;
  /**
   * Completed steps so far in this agent session (for context-aware predictions).
   * Each entry is a lightweight summary — action label + page URL.
   */
  stepHistory?: Array<{ action: string; pageUrl: string }>;
  /**
   * Full turn-by-turn conversation history: page state + AI decision + DOM result.
   * Richer than stepHistory — used to give the AI full session memory.
   */
  turnHistory?: AgentTurn[];
  /**
   * The full step-by-step plan generated at the start of the agent session.
   * Included so the AI can stay on track with the original intent.
   */
  plan?: string;
  /**
   * The 1-based index of the plan step the agent should execute next.
   * Derived from completed step count so the AI knows exactly where it is.
   */
  currentPlanStep?: number;
  /**
   * Rich element list for the agent tool-calling prompt.
   * Each entry includes a label and type (button, link, input, etc.).
   * Populated by content.ts when calling callAgentTool.
   */
  pageElements?: AgentPageElement[];
  /**
   * The current page URL, included for the agent tool prompt.
   */
  currentUrl?: string;
  /**
   * A summary of what changed on the page after the previous agent action —
   * new/removed elements, URL/title changes.
   * Populated by prediction.ts before each callAgentTool() call.
   */
  postActionObservation?: PostActionObservation;
}

/**
 * The structured response expected from an AI Provider.
 */
export interface AIPrediction {
  /**
   * The predicted label or identifier of the next action to be taken.
   * This should correspond to one of the labels in `topVisibleActions`.
   */
  predictedActionLabel: string;
  /**
   * The AI's reasoning for choosing the predicted action, for debugging and transparency.
   */
  reasoning: string;
  /**
   * A score from 0.0 to 1.0 indicating the AI's confidence in its prediction.
   */
  confidenceEstimate: number;
  /**
   * For TYPE actions only — the exact text the agent should type into the
   * target input/textarea field (e.g. 'iphone 17 pro'). Omitted for click actions.
   */
  inputText?: string;
}
