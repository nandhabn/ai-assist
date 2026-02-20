// src/types/ai.ts

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
}
