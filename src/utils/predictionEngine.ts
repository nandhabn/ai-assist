/**
 * @file predictionEngine.ts
 * @description Ranks potential user actions based on page context.
 *
 * @architecture This module is a pure, functional utility that operates exclusively on
 * the data provided in the `PageContext` object. It introduces no side effects,
 * DOM queries, or asynchronous operations, ensuring high performance (<5ms) and
 * testability. It lives in the `utils` layer and can be safely executed within the
 * content script context.
 *
 * @scoring-rationale The scoring model is a weighted heuristic designed to mimic human
 * intuition for determining the "next best action."
 *
 *   - Proximity Score (Weight: 0.35): Prioritizes actions spatially close to the
 *     last interaction, reflecting the common pattern of localized workflow steps.
 *     Normalization against the viewport diagonal makes the score independent of
 *     screen size.
 *
 *   - Intent Score (Weight: 0.25): Aligns action ranking with the semantic purpose
 *     of the page (e.g., on a 'checkout' page, 'Pay Now' is more important than
 *     'Terms of Service'). This is a rule-based system that can be expanded.
 *
 *   - Form Score (Weight: 0.20): Creates a "form gravity" effect. Once a user
 *     starts interacting with a form, other elements within that same form are
 *     given priority, especially the primary submission button.
 *
 *   - Role Score (Weight: 0.10): Uses pre-assigned roles from the ContextBuilder to
 *     give inherent priority to 'primary' actions over 'secondary' or simple 'links'.
 *
 *   - Base Score (Weight: 0.10): Incorporates the initial confidence score from the
 *     ContextBuilder, which assesses an element's likelihood of being a meaningful
 *     action candidate.
 *
 * @trade-offs
 *   - Rule-Based Rigidity: The intent scoring is based on a static, hand-written
 *     set of rules. It will not adapt to novel UI patterns or languages without
 *     being explicitly updated. It favors common English keywords.
 *   - Context Dependency: The engine's accuracy is entirely dependent on the quality
 *     of the incoming `PageContext`. If the `pageIntent` is wrong or `ActionCandidate`
 *     roles are misclassified, the predictions will be skewed.
 *   - No Visual Understanding: The engine cannot understand visual hierarchy beyond
 *     what is encoded in `role` and `boundingBox`. A large, visually prominent button
 *     might be out-scored by a small, poorly-styled link if other heuristics align.
 *
 * @ai-fallback-integration To enhance this engine with AI, a fallback mechanism can be
 *   implemented within the `generatePredictions` function.
 *
 *   1.  **Confidence Threshold:** If the `confidence` score of the rule-based result
 *       is below a certain threshold (e.g., 0.25), it indicates ambiguity.
 *   2.  **AI Service Call:** In cases of low confidence, the engine could serialize the
 *       `PageContext` and send it to a secure backend service (NEVER call an AI service
 *       directly from the client with credentials).
 *   3.  **Backend Processing:** The backend would format the context into a prompt for a
 *       Large Language Model (LLM). The prompt would ask the LLM to rank the
 *       `visibleActions` based on the `pageIntent` and `lastUserAction`.
 *   4.  **Return and Merge:** The backend returns the AI-ranked list. The `predictionEngine`
 *       can then replace or merge its rule-based results with the more nuanced AI results.
 *       This preserves performance for high-confidence predictions while leveraging AI
 *       for complex or ambiguous cases.
 */

// --- TYPE DEFINITIONS ---
// These would typically be imported from a central types file.

/**
 * Represents a clickable or interactive element on the page.
 */
export interface ActionCandidate {
  label: string;
  selector: string; // Stable CSS selector
  role: 'primary' | 'secondary' | 'link' | 'unknown';
  boundingBox: DOMRect;
  confidenceScore: number; // Base confidence from the context builder
  formSelector?: string; // CSS selector of the parent form, if any
}

/**
 * Represents a form element on the page.
 */
export interface Form {
  selector: string;
  completionScore: number; // 0 to 1
  fields: { name: string; type: string; value: unknown }[]; // Privacy-safe, no values
}

/**
 * Represents the last user interaction.
 */
export interface UserAction {
  type: 'click' | 'input' | 'submit';
  selector: string;
  formSelector?: string; // CSS selector of the parent form, if any
}

/**
 * The full context of the page at a given moment.
 */
export interface PageContext {
  pageIntent: string; // e.g., 'authentication', 'search', 'checkout', 'navigation'
  visibleActions: ActionCandidate[];
  forms: Form[];
  lastUserAction: UserAction | null;
  lastActionRect: DOMRect | null;
  viewport: {
    width: number;
    height: number;
  };
}

/**
 * The detailed breakdown of a prediction's score.
 */
export interface ScoreBreakdown {
  proximityScore: number;
  intentScore: number;
  formScore: number;
  roleScore: number;
  directionScore: number; // NEW: Added directional bias
}

/**
 * An action candidate with its calculated rank and score.
 */
export interface RankedPrediction {
  action: ActionCandidate;
  totalScore: number;
  breakdown: ScoreBreakdown;
}

/**
 * The final output of the prediction engine.
 */
export interface PredictionResult {
  topThree: RankedPrediction[];
  confidence: number; // Overall confidence (topScore - secondScore)
}

// --- CONSTANTS ---
// Refactored weights to include directional bias and prioritize form continuity.
const WEIGHTS = {
  PROXIMITY: 0.30,
  INTENT: 0.25,
  FORM: 0.25,
  ROLE: 0.1,
  DIRECTION: 0.1,
};

const NEUTRAL_SCORE = 0.5;

// --- SCORING MODULES ---

/**
 * Calculates the center of a DOMRect.
 */
const getCenter = (rect: DOMRect): { x: number; y: number } => {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
};

/**
 * Calculates proximity score based on distance from the last user action.
 * Closer actions get a higher score.
 * @returns Score between 0 and 1.
 */
function calculateProximityScore(
  lastActionRect: DOMRect | null,
  candidateBoundingBox: DOMRect,
  viewport: { width: number; height: number }
): number {
  if (!lastActionRect) {
    return NEUTRAL_SCORE;
  }

  const lastActionCenter = getCenter(lastActionRect);
  const candidateCenter = getCenter(candidateBoundingBox);

  const distance = Math.sqrt(
    Math.pow(lastActionCenter.x - candidateCenter.x, 2) +
    Math.pow(lastActionCenter.y - candidateCenter.y, 2)
  );

  const viewportDiagonal = Math.sqrt(
    Math.pow(viewport.width, 2) + Math.pow(viewport.height, 2)
  );
  
  if (viewportDiagonal === 0) {
      return NEUTRAL_SCORE; // Avoid division by zero
  }

  const normalizedDistance = Math.min(distance / viewportDiagonal, 1.0);

  // Score is inverse of distance
  const score = 1.0 - normalizedDistance;
  
  return Math.max(0, Math.min(score, 1)); // Clamp between 0 and 1
}

/**
 * Calculates intent alignment score.
 * Boosts actions that match the inferred page intent.
 * @returns Score between 0 and 1.
 */
function calculateIntentScore(
  pageIntent: string,
  candidate: ActionCandidate
): number {
  const label = candidate.label.toLowerCase();

  switch (pageIntent) {
    case 'authentication':
      if (candidate.role === 'primary' && (label.includes('login') || label.includes('sign in') || label.includes('submit'))) {
        return 1.0;
      }
      if (candidate.selector.includes('password')) { // Assuming selector might give a hint
        return 0.8;
      }
      return 0.4;

    case 'search':
      if (candidate.role === 'primary' && (label.includes('search') || candidate.selector.includes('[type="submit"]'))) {
        return 1.0;
      }
      if (label.includes('filter') || label.includes('sort')) {
        return 0.8;
      }
       if (candidate.selector.includes('search')) {
        return 0.9;
      }
      return 0.5;

    case 'checkout':
      if (candidate.role === 'primary' && (label.includes('continue') || label.includes('submit') || label.includes('pay') || label.includes('checkout'))) {
        return 1.0;
      }
       if (label.includes('cart') || label.includes('address') || label.includes('payment')) {
        return 0.8;
      }
      return 0.5;

    case 'navigation':
      if (candidate.role === 'primary' || candidate.role === 'link') {
        return 0.8;
      }
      return 0.4;

    default:
      return NEUTRAL_SCORE;
  }
}

/**
 * Calculates same-form bias score with continuity boost.
 * Boosts actions within the same form as the last interaction.
 * @returns Score between 0.2 and 0.9.
 */
function calculateFormScore(
  lastUserAction: UserAction | null,
  candidate: ActionCandidate
): number {
  if (!lastUserAction || !lastUserAction.formSelector) {
    return NEUTRAL_SCORE; // No basis for form-related scoring.
  }

  // Action is inside a form.
  if (candidate.formSelector) {
    if (candidate.formSelector === lastUserAction.formSelector) {
      // FORM CONTINUITY BOOST: User is active in this form.
      // The strong primary role boost is now handled multiplicatively post-score-calculation.
      return 0.9;
    } else {
      // User was in a different form, penalize actions in other forms.
      return 0.2;
    }
  }

  // Action is not in any form, but last action was. Penalize slightly.
  return 0.4;
}

/**
 * Calculates role score.
 * Assigns a score based on the action's designated role.
 * @returns Score between 0 and 1.
 */
function calculateRoleScore(role: ActionCandidate['role']): number {
  switch (role) {
    case 'primary':
      return 1.0;
    case 'secondary':
      return 0.7;
    case 'link':
      return 0.5;
    case 'unknown':
    default:
      return 0.3;
  }
}

/**
 * NEW: Calculates directional flow bias.
 * Simulates natural top-to-bottom, left-to-right reading/interaction flow.
 * @returns Score between 0.3 and 1.0.
 */
function calculateDirectionScore(
  lastActionRect: DOMRect | null,
  candidateBoundingBox: DOMRect,
  viewport: { width: number, height: number }
): number {
  if (!lastActionRect) {
    return NEUTRAL_SCORE;
  }

  let score = NEUTRAL_SCORE;

  // Vertical bias: Strongly prefer actions below the last one.
  const verticalDelta = candidateBoundingBox.top - lastActionRect.bottom;
  if (verticalDelta > 0) {
    // Boost for downward flow, normalized by viewport height.
    const downwardBias = 1.0 - Math.min(verticalDelta / viewport.height, 1.0);
    score += (0.4 * downwardBias); // Strong boost
  } else if (candidateBoundingBox.bottom < lastActionRect.top) {
    score -= 0.15; // Penalize upward flow.
  }

  // Horizontal bias: Slightly prefer actions to the right of the last one.
  const horizontalDelta = candidateBoundingBox.left - lastActionRect.left;
  if (horizontalDelta > 0) {
    const rightwardBias = 1.0 - Math.min(horizontalDelta / viewport.width, 1.0);
     score += (0.1 * rightwardBias); // Slight boost
  }

  return Math.max(0.3, Math.min(score, 1.0)); // Clamp between 0.3 and 1.0
}


// --- MAIN ENGINE ---

/**
 * Ranks visible action candidates based on a weighted scoring model.
 * The model considers spatial proximity, intent alignment, form context, and action role.
 * This is a pure function with no side effects or DOM access.
 *
 * @param context The current page context provided by the ContextBuilder.
 * @returns A PredictionResult containing the top three ranked actions and a confidence score.
 */
export function generatePredictions(
  context: PageContext
): PredictionResult {
  const { visibleActions, lastActionRect, pageIntent, lastUserAction, viewport } = context;

  if (!visibleActions || visibleActions.length === 0) {
    return { topThree: [], confidence: 0 };
  }

  const rankedCandidates: RankedPrediction[] = visibleActions.map(action => {
    const breakdown: ScoreBreakdown = {
      proximityScore: calculateProximityScore(lastActionRect, action.boundingBox, viewport),
      intentScore: calculateIntentScore(pageIntent, action),
      formScore: calculateFormScore(lastUserAction, action),
      roleScore: calculateRoleScore(action.role),
      directionScore: calculateDirectionScore(lastActionRect, action.boundingBox, viewport),
    };

    let totalScore =
      breakdown.proximityScore * WEIGHTS.PROXIMITY +
      breakdown.intentScore * WEIGHTS.INTENT +
      breakdown.formScore * WEIGHTS.FORM +
      breakdown.roleScore * WEIGHTS.ROLE +
      breakdown.directionScore * WEIGHTS.DIRECTION;

    // --- Hard Form Dominance & Penalty Layer ---
    if (lastUserAction?.formSelector) {
      if (action.formSelector && action.formSelector === lastUserAction.formSelector) {
        // TASK 2: If candidate is a primary action in the same form, apply multiplicative dominance.
        if (action.role === 'primary') {
          totalScore *= 1.25;
        }
      } else if (action.formSelector !== lastUserAction.formSelector) {
        // TASK 3: If candidate is outside the active form, apply a penalty.
        totalScore *= 0.75;
      }
    }

    return {
      action,
      totalScore,
      breakdown,
    };
  });

  // Sort candidates by total score in descending order
  rankedCandidates.sort((a, b) => b.totalScore - a.totalScore);

  const topThree = rankedCandidates.slice(0, 3);

  // TASK 1: Temporarily log breakdown for top 3 actions for debugging.
  console.table(topThree.map(t => ({
    label: t.action.label,
    proximity: t.breakdown.proximityScore,
    intent: t.breakdown.intentScore,
    form: t.breakdown.formScore,
    role: t.breakdown.roleScore,
    direction: t.breakdown.directionScore,
    total: t.totalScore
  })));

  let confidence = 0;
  if (topThree.length > 0 && topThree[0].totalScore > 0) {
      const topScore = topThree[0].totalScore;
      if (topThree.length > 1) {
          const secondScore = topThree[1].totalScore;
          // OBJECTIVE 2 FIX: Normalize confidence score.
          // This calculates the drop-off from the top score to the second score,
          // relative to the top score's magnitude. A 10% drop-off feels the same
          // whether scores are high (0.9 vs 0.81) or low (0.2 vs 0.18).
          confidence = (topScore - secondScore) / topScore;
      } else {
          // If there is no second action, we are 100% confident in our top choice.
          confidence = 1;
      }
  }
  
  // Clamp confidence between 0 and 1.
  confidence = Math.max(0, Math.min(confidence, 1));

  return {
    topThree,
    confidence,
  };
}
