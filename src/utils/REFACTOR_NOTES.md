# Refactoring Notes: Hardening the AI Fallback Orchestrator

This document explains the improvements made to the `maybeUseAI` function and its related helpers in `predictionEngine.ts`. The goal of this refactoring was to move from a simplistic, brittle fallback mechanism to a robust, stable, and more intelligent AI orchestration system.

### 1. Correct `CompactContext` Creation

-   **Previous State**: `lastActionLabel` was incorrectly populated with a CSS selector (`context.lastUserAction?.selector`). This provided the AI with cryptic, non-semantic information.
-   **New State**: The logic now correctly resolves the human-readable label by searching `visibleActions` for the corresponding selector.
-   **Why it Improves Stability**: The AI now receives a semantically meaningful label for the last action (e.g., "Log In" instead of `button.btn.btn-primary`). This dramatically improves the quality of the context, leading to more accurate predictions from the AI model and reducing nonsensical suggestions.

### 2. Semantic Matching over Exact Matching

-   **Previous State**: The system used a strict equality check (`a.label === aiPrediction.predictedActionLabel`) to find the action suggested by the AI. This is extremely brittle and fails on minor differences in whitespace, casing, or wording (e.g., "Sign in" vs. "Sign In").
-   **New State**: A `calculateSimilarity` function now performs token-based fuzzy matching. It normalizes strings and calculates a Jaccard similarity score. The system now picks the on-page element that is *most semantically similar* to the AI's suggestion, with a configurable threshold (`> 0.5`) to discard poor matches.
-   **Why it Improves Stability**: The system is now resilient to the inherent "fuzziness" of Large Language Models. It can correctly map an AI's reasonable suggestion (e.g., "continue to checkout") to an actual button labeled "Continue" or "Proceed to Checkout". This significantly increases the hit rate of valid AI suggestions.

### 3. Principled Score Merging over Artificial Boosts

-   **Previous State**: A "magic number" (`* 1.1`) was used to artificially boost the AI prediction's score and force it to the top. This was unpredictable and didn't respect the AI's own confidence level.
-   **New State**: The new `aiScore` is calculated based on the current top deterministic score and, crucially, the AI's own `confidenceEstimate`. The formula `topDeterministicScore * (0.8 + 0.4 * aiConfidence)` ensures that a high-confidence AI suggestion receives a significant score, while a low-confidence one receives a much smaller one. The result is then correctly sorted into the list, not blindly promoted.
-   **Why it Improves Stability**: This change introduces a more predictable and fair competition between the deterministic and AI engines. The AI's ranking is now proportional to its confidence, preventing a low-confidence but lucky guess from overriding a strong deterministic candidate. It ensures the final ranking is a more accurate reflection of all available information.

### 4. Gating and Rate-Limiting

-   **Previous State**: The AI provider was called whenever deterministic confidence was low, with no other checks.
-   **New State**: Two new guards have been added:
    1.  **AI Confidence Gate**: The AI's suggestion is completely ignored if its own confidence is low (`<= 0.5`).
    2.  **Rate Limiting**: The AI provider cannot be called more than once per second.
-   **Why it Improves Stability**:
    -   The confidence gate prevents the system from wasting time and computation on low-quality AI suggestions that are likely to be wrong anyway. It acts as a crucial quality filter.
    -   The rate limiter prevents a fluctuating UI or rapid user actions from spamming the AI API, which could lead to performance issues, unnecessary costs, and hitting API rate limits. It enforces a more controlled and predictable usage pattern.

Overall, these changes transform the AI fallback from a fragile proof-of-concept into a production-ready system that is more intelligent, resilient, and predictable.