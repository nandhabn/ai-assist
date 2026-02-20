/**
 * @file Prediction Engine and Form Filling Module
 * @description Provides dual functionality:
 * 1. Ranks potential user actions based on page context (Prediction Engine).
 * 2. Safely and intelligently fills web forms (Form-Filling Module).
 * @architecture This module is designed for the content script layer. It directly interacts
 * with the DOM.
 */

// --- COMMON TYPE DEFINITIONS ---
// Exported for use in other modules like `content.ts`.

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
 * Represents a form on the page.
 */
export interface Form {
  selector: string;
  completionScore: number; // 0 to 1
  fields: { name: string; type: string; value: unknown }[]; // Privacy-safe, no values
}

/**
 * Represents a user interaction.
 */
export interface UserAction {
  type: 'click' | 'input' | 'submit' | 'focus';
  selector: string;
  formSelector?: string; // CSS selector of the parent form, if any
  elementMetadata?: {
    parentForm?: string;
  };
}

/**
 * The full context of the page at a given moment for prediction.
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
  directionScore: number;
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


// ===================================================================================
// --- PREDICTION ENGINE MODULE ---
// Re-instated to fix build errors from `content.ts`.
// ===================================================================================

const WEIGHTS = {
  PROXIMITY: 0.30,
  INTENT: 0.25,
  FORM: 0.25,
  ROLE: 0.1,
  DIRECTION: 0.1,
};

const NEUTRAL_SCORE = 0.5;

const getCenter = (rect: DOMRect): { x: number; y: number } => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

function calculateProximityScore(lastActionRect: DOMRect | null, candidateBoundingBox: DOMRect, viewport: { width: number; height: number }): number {
  if (!lastActionRect) return NEUTRAL_SCORE;
  const lastActionCenter = getCenter(lastActionRect);
  const candidateCenter = getCenter(candidateBoundingBox);
  const distance = Math.sqrt(Math.pow(lastActionCenter.x - candidateCenter.x, 2) + Math.pow(lastActionCenter.y - candidateCenter.y, 2));
  const viewportDiagonal = Math.sqrt(Math.pow(viewport.width, 2) + Math.pow(viewport.height, 2));
  if (viewportDiagonal === 0) return NEUTRAL_SCORE;
  const normalizedDistance = Math.min(distance / viewportDiagonal, 1.0);
  return Math.max(0, Math.min(1.0 - normalizedDistance, 1));
}

function calculateIntentScore(pageIntent: string, candidate: ActionCandidate): number {
  const label = candidate.label.toLowerCase();
  switch (pageIntent) {
    case 'authentication':
      if (candidate.role === 'primary' && (label.includes('login') || label.includes('sign in') || label.includes('submit'))) return 1.0;
      if (candidate.selector.includes('password')) return 0.8;
      return 0.4;
    case 'search':
      if (candidate.role === 'primary' && (label.includes('search') || candidate.selector.includes('[type="submit"]'))) return 1.0;
      if (label.includes('filter') || label.includes('sort')) return 0.8;
      if (candidate.selector.includes('search')) return 0.9;
      return 0.5;
    case 'checkout':
      if (candidate.role === 'primary' && (label.includes('continue') || label.includes('submit') || label.includes('pay') || label.includes('checkout'))) return 1.0;
      if (label.includes('cart') || label.includes('address') || label.includes('payment')) return 0.8;
      return 0.5;
    case 'navigation':
      if (candidate.role === 'primary' || candidate.role === 'link') return 0.8;
      return 0.4;
    default:
      return NEUTRAL_SCORE;
  }
}

function calculateFormScore(lastUserAction: UserAction | null, candidate: ActionCandidate): number {
  if (!lastUserAction?.formSelector) return NEUTRAL_SCORE;
  if (candidate.formSelector) {
    return candidate.formSelector === lastUserAction.formSelector ? 0.9 : 0.2;
  }
  return 0.4;
}

function calculateRoleScore(role: ActionCandidate['role']): number {
  const scores = { primary: 1.0, secondary: 0.7, link: 0.5, unknown: 0.3 };
  return scores[role] || 0.3;
}

function calculateDirectionScore(lastActionRect: DOMRect | null, candidateBoundingBox: DOMRect, viewport: { width: number, height: number }): number {
  if (!lastActionRect) return NEUTRAL_SCORE;
  let score = NEUTRAL_SCORE;
  const verticalDelta = candidateBoundingBox.top - lastActionRect.bottom;
  if (verticalDelta > 0) {
    score += (0.4 * (1.0 - Math.min(verticalDelta / viewport.height, 1.0)));
  } else if (candidateBoundingBox.bottom < lastActionRect.top) {
    score -= 0.15;
  }
  const horizontalDelta = candidateBoundingBox.left - lastActionRect.left;
  if (horizontalDelta > 0) {
    score += (0.1 * (1.0 - Math.min(horizontalDelta / viewport.width, 1.0)));
  }
  return Math.max(0.3, Math.min(score, 1.0));
}

function isLikelySubmitAction(candidate: ActionCandidate): boolean {
    const selector = candidate.selector.toLowerCase();
    const label = candidate.label.toLowerCase();
    if (selector.includes('[type="submit"]')) return true;
    const submitKeywords = ['log in', 'sign in', 'submit'];
    if (submitKeywords.some(keyword => label.includes(keyword))) return true;
    if (selector.includes('[name="login"]') || selector.includes('[data-testid*="login"]') || selector.includes('[data-testid*="submit"]')) return true;
    return false;
}

/**
 * Ranks visible action candidates based on a weighted scoring model.
 */
export function generatePredictions(context: PageContext): PredictionResult {
  const { visibleActions, lastActionRect, pageIntent, lastUserAction, viewport } = context;
  if (!visibleActions || visibleActions.length === 0) return { topThree: [], confidence: 0 };

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

    if (lastUserAction?.formSelector && action.formSelector === lastUserAction.formSelector) {
        if (isLikelySubmitAction(action)) totalScore *= 1.35;
        else if (action.role === 'link' || action.label.toLowerCase().includes('forgot')) totalScore *= 0.85;
        else totalScore *= 1.05;
    } else if (lastUserAction?.formSelector && action.formSelector) {
        totalScore *= 0.75;
    }

    return { action, totalScore, breakdown };
  });

  rankedCandidates.sort((a, b) => b.totalScore - a.totalScore);
  const topThree = rankedCandidates.slice(0, 3);
  let confidence = 0;
  if (topThree.length > 0 && topThree[0].totalScore > 0) {
    const topScore = topThree[0].totalScore;
    confidence = topThree.length > 1 ? (topScore - topThree[1].totalScore) / topScore : 1;
  }

  return { topThree, confidence: Math.max(0, Math.min(confidence, 1)) };
}


import {
  AIProvider,
  CompactContext,
  AIPrediction,
} from '../types/ai';

// ===================================================================================
// --- AI FALLBACK ORCHESTRATOR (v2 - Hardened) ---
// ===================================================================================

let lastAICallTimestamp = 0;
const AI_CALL_RATE_LIMIT = 1000; // 1 second

/**
 * Calculates a similarity score between two strings based on token overlap.
 * @param strA The first string (e.g., from an AI prediction).
 * @param strB The second string (e.g., from a DOM element label).
 * @returns A score from 0.0 to 1.0.
 * @private
 */
function calculateSimilarity(strA: string, strB: string): number {
  const normalize = (s: string) => s.toLowerCase().trim().split(/\s+/);
  const tokensA = new Set(normalize(strA));
  const tokensB = new Set(normalize(strB));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  
  // Jaccard similarity
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

/**
 * Converts the detailed PageContext into a compact format suitable for an AI prompt.
 * @param context The full page context.
 * @returns A lightweight, serializable context.
 * @private
 */
function createCompactContext(context: PageContext): CompactContext {
  let lastActionLabel: string | undefined = context.lastUserAction?.selector;
  if (context.lastUserAction?.selector) {
    const lastAction = context.visibleActions.find(
      a => a.selector === context.lastUserAction?.selector
    );
    if (lastAction) {
      lastActionLabel = lastAction.label;
    }
  }

  return {
    pageIntent: context.pageIntent,
    lastActionLabel: lastActionLabel,
    topVisibleActions: context.visibleActions.map(a => a.label),
    formFields: context.forms.flatMap(f => f.fields.map(field => field.name)),
  };
}

/**
 * Orchestrates when to use a deterministic prediction vs. an AI-powered prediction.
 * This hardened version includes rate limiting, confidence gating, and semantic matching.
 *
 * @param context The full context of the page.
 * @param deterministicResult The pre-computed result from the deterministic engine.
 * @param aiProvider An instance of an AI provider (e.g., GeminiProvider).
 * @returns A `PredictionResult` that may be augmented with an AI prediction.
 */
export async function maybeUseAI(
  context: PageContext,
  deterministicResult: PredictionResult,
  aiProvider: AIProvider
): Promise<PredictionResult> {
  const { confidence, topThree } = deterministicResult;

  // 1. High-Confidence Case or No Actions: Trust the deterministic result.
  if (confidence > 0.4 || context.visibleActions.length === 0) {
    return deterministicResult;
  }
  
  // 2. Rate Limiting Guard: Prevent API spam.
  const now = Date.now();
  if (now - lastAICallTimestamp < AI_CALL_RATE_LIMIT) {
    return deterministicResult;
  }

  // 3. Low-Confidence Case: Attempt to fall back to the AI provider.
  if (confidence < 0.2) {
    try {
      lastAICallTimestamp = now; // Update timestamp before the async call
      const compactContext = createCompactContext(context);
      const aiPrediction = await aiProvider.predictNextAction(compactContext);

      // 4. AI Confidence Gate: Only trust confident AI predictions.
      if (aiPrediction.confidenceEstimate <= 0.5) {
        return deterministicResult;
      }

      // 5. Semantic Matching: Find the best matching candidate for the AI's label.
      const candidatesWithSimilarity = context.visibleActions
        .map(action => ({
          action,
          similarity: calculateSimilarity(aiPrediction.predictedActionLabel, action.label),
        }))
        .filter(item => item.similarity > 0.5); // Similarity Gate

      if (candidatesWithSimilarity.length === 0) {
        return deterministicResult; // No sufficiently similar action found.
      }
      
      candidatesWithSimilarity.sort((a, b) => b.similarity - a.similarity);
      const bestMatch = candidatesWithSimilarity[0];

      // 6. Principled Score Merging: Convert AI confidence to a score and re-sort.
      const topDeterministicScore = topThree[0]?.totalScore || 0.5;
      const aiScore = topDeterministicScore * (0.8 + 0.4 * aiPrediction.confidenceEstimate);

      const aiRankedPrediction: RankedPrediction = {
        action: bestMatch.action,
        totalScore: aiScore,
        breakdown: { // -1 indicates an AI-driven score
          proximityScore: -1, intentScore: -1, formScore: -1, roleScore: -1, directionScore: -1,
        },
      };

      // Remove the matched action if it's already in the top three to avoid duplicates.
      const finalPredictions = topThree.filter(p => p.action.selector !== bestMatch.action.selector);
      finalPredictions.push(aiRankedPrediction);
      finalPredictions.sort((a, b) => b.totalScore - a.totalScore);

      // 7. Recalculate Final Result
      const newTopThree = finalPredictions.slice(0, 3);
      const newTopScore = newTopThree[0]?.totalScore || 0;
      const newSecondScore = newTopThree[1]?.totalScore || 0;
      const newConfidence = newTopScore > 0 ? (newTopScore - newSecondScore) / newTopScore : 1;
      
      return {
        topThree: newTopThree,
        confidence: Math.max(0, Math.min(newConfidence, 1.0)),
      };

    } catch (error) {
      console.error('AI Fallback failed:', error);
      return deterministicResult; // On error, always return the safe deterministic result.
    }
  }

  // 8. Mid-Confidence or No-AI Case: Return original result.
  return deterministicResult;
}



// ===================================================================================
// --- HARDENED FORM-FILLING MODULE ---
// ===================================================================================

interface FillOptions {
  force?: boolean;
  delay?: number;
}

interface FillReport {
  filled: string[];
  skipped: string[];
  notFound: string[];
  errors: { field: string; message: string }[];
}

interface FieldMatch {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  score: number;
}

function getValueSetter(element: HTMLElement): PropertyDescriptor | null {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const proto = Object.getPrototypeOf(element);
        return Object.getOwnPropertyDescriptor(proto, 'value') || null;
    }
    return null;
}

function safeSetValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: any, options: { force?: boolean } = {}): 'filled' | 'skipped' | 'error' {
  if (element.disabled || (element as HTMLInputElement).readOnly) return 'skipped';

  const elementType = (element as HTMLInputElement).type?.toLowerCase();

  if (elementType === 'checkbox') {
    const checkbox = element as HTMLInputElement;
    const targetState = typeof value === 'boolean' ? value : (value === checkbox.value);
    if (!options.force && checkbox.checked === targetState) return 'skipped';
    checkbox.checked = targetState;
    checkbox.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return 'filled';
  }

  if (elementType === 'radio') {
    const radio = element as HTMLInputElement;
    const targetState = radio.value === value;
    if (!options.force && radio.checked === targetState) return 'skipped';
    if(targetState) {
        radio.click();
        return 'filled';
    }
    return 'skipped';
  }

  if (element.nodeName.toLowerCase() === 'select') {
    const select = element as HTMLSelectElement;
    if (!options.force && select.value === String(value)) return 'skipped';
    const optionToSelect = Array.from(select.options).find(opt => opt.value === String(value) || opt.text === String(value));
    if (optionToSelect) {
        const setter = getValueSetter(select);
        (setter?.set) ? setter.set.call(select, optionToSelect.value) : (select.value = optionToSelect.value);
    } else {
        return 'error';
    }
  } else {
    const currentValue = (element as HTMLInputElement | HTMLTextAreaElement).value;
    if (!options.force && (currentValue && currentValue !== '')) return 'skipped';
    if (!options.force && currentValue === String(value)) return 'skipped';
    const setter = getValueSetter(element);
    (setter?.set) ? setter.set.call(element, String(value)) : ((element as HTMLInputElement | HTMLTextAreaElement).value = String(value));
  }

  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return 'filled';
}

function normalize(str: string | null | undefined): string {
  return (str || '').toLowerCase().replace(/[\s_-]/g, '');
}

function findBestFieldMatch(elements: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[], key: string): FieldMatch | null {
  const normalizedKey = normalize(key);
  let bestMatch: FieldMatch | null = null;
  for (const element of elements) {
    let score = 0;
    if (normalize(element.name) === normalizedKey) score = 1.0;
    else if (normalize(element.id) === normalizedKey) score = 0.95;
    else if (normalize(element.getAttribute('aria-label')) === normalizedKey) score = 0.9;
    else {
        let labelText = '';
        if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
            if (label) labelText = normalize(label.textContent);
        }
        if (!labelText) {
            const parentLabel = element.closest('label');
            if (parentLabel) labelText = normalize(parentLabel.textContent);
        }
        if (labelText === normalizedKey) score = 0.85;
        else if (normalize((element as HTMLInputElement).placeholder).includes(normalizedKey)) score = 0.7;
    }
    if (score > (bestMatch?.score || 0)) {
        bestMatch = { element, score };
    }
  }
  return bestMatch && bestMatch.score >= 0.7 ? bestMatch : null;
}

export async function fillFormFields(formSelector: string, dataMap: Record<string, any>, options: FillOptions = {}): Promise<FillReport> {
  const form = document.querySelector<HTMLFormElement>(formSelector);
  const report: FillReport = { filled: [], skipped: [], notFound: [], errors: [] };
  if (!form) {
    report.notFound = Object.keys(dataMap);
    return report;
  }

  const fillableElements = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select'));
  const filledElements = new Set<Element>();
  const delay = options.delay ?? 40;

  for (const [key, value] of Object.entries(dataMap)) {
    const match = findBestFieldMatch(fillableElements.filter(el => !filledElements.has(el)) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[], key);
    if (!match) {
      report.notFound.push(key);
      continue;
    }
    const { element } = match;
    const inputEl = element as HTMLInputElement;
    if (inputEl.type?.toLowerCase() === 'radio' && inputEl.name) {
        const groupName = inputEl.name;
        const radiosInGroup = Array.from(form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"]`));
        let radioToSelect = radiosInGroup.find(r => r.value === String(value));
        if (radioToSelect) {
            const status = safeSetValue(radioToSelect, String(value), options);
             if (status === 'filled') {
                report.filled.push(key);
                radiosInGroup.forEach(r => filledElements.add(r));
            } else if (status === 'skipped') {
                report.skipped.push(key);
            }
        } else {
             report.notFound.push(key);
        }
    } else {
        const status = safeSetValue(element, value, options);
        switch (status) {
            case 'filled': report.filled.push(key); filledElements.add(element); break;
            case 'skipped': report.skipped.push(key); break;
            case 'error': report.errors.push({ field: key, message: `Could not set value for element.` }); break;
        }
    }
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }
  return report;
}

async function __fillActiveForm(dataMap: Record<string, any>, options?: FillOptions): Promise<void> {
  let activeFormSelector: string | undefined;
  try {
    const result = await chrome.storage.local.get('flowRecorder_lastUserAction');
    const lastUserAction = result.flowRecorder_lastUserAction as UserAction | undefined;
    
    // The form selector is nested inside the `elementMetadata` property.
    activeFormSelector = lastUserAction?.elementMetadata?.parentForm;
  } catch (e) {
     console.error("[Form Filler] Error accessing chrome.storage.local.", e);
     return;
  }
  if (!activeFormSelector) {
    console.error('[Form Filler] Aborted: No active form detected.');
    return;
  }
  console.log(`[Form Filler] Active form detected: ${activeFormSelector}. Starting fill...`);
  const report = await fillFormFields(activeFormSelector, dataMap, options);
  console.log('%c[Form Filler] Operation Complete.', 'font-weight: bold;');
  console.table({
      filled: { fields: report.filled.join(', ') || 'None' },
      skipped: { fields: report.skipped.join(', ') || 'None' },
      notFound: { fields: report.notFound.join(', ') || 'None' },
      errors: { count: report.errors.length },
  });
  if (report.errors.length > 0) console.error('[Form Filler] Errors:', report.errors);
}

if (typeof window !== 'undefined') {
    (window as any).__fillActiveForm = __fillActiveForm;
}
