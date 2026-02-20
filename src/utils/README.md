# AI Abstraction Layer Documentation

This document outlines the provider-agnostic AI architecture designed for the AI Flow Recorder extension. The primary goal is to create a flexible system where different AI model providers (like Google Gemini or Amazon Nova) can be used interchangeably for predicting user actions without altering the core application logic.

## 1. Provider-Agnostic Design

The architecture is built around the `AIProvider` interface, which acts as a contract for all AI prediction services.

**Location**: `src/types/ai.ts`

```typescript
export interface AIProvider {
  predictNextAction(context: CompactContext): Promise<AIPrediction>;
}
```

Any part of the application that needs an AI prediction does not interact directly with a specific provider's implementation (e.g., `GeminiProvider`). Instead, it relies on this interface.

### How it Works:

1.  **Interface Contract**: The `AIProvider` interface guarantees that every provider has a `predictNextAction` method that accepts a standardized `CompactContext` and returns a standardized `AIPrediction`. This ensures a predictable, uniform I/O signature.

2.  **Provider Factory**: The `createAIProvider` function in `src/utils/aiProviderFactory.ts` acts as a centralized factory. It maintains a `providerRegistry` that maps a simple string name (e.g., `"gemini"`) to a function that can instantiate the corresponding provider class.

3.  **Dynamic Instantiation**: The application can select which provider to use via a configuration value (e.g., fetched from `chrome.storage`). The factory then creates the correct provider instance at runtime.

4.  **Decoupled Logic**: The `maybeUseAI` orchestrator in `src/utils/predictionEngine.ts` receives an instance of an `AIProvider`. It doesn't know or care if it's `GeminiProvider` or `NovaProvider`; it only knows that it can call `.predictNextAction()`.

This separation of concerns means the core logic is completely decoupled from the specific implementation details of any single AI service.

---

## 2. `GeminiProvider` Implementation

The first implementation of the `AIProvider` interface is `GeminiProvider`.

**Location**: `src/utils/geminiProvider.ts`

### Key Features:

-   **Implements `AIProvider`**: Strictly adheres to the interface contract.
-   **Structured Prompts**: Sends a minimal, structured prompt containing only the `CompactContext` to keep token usage low and responses predictable.
-   **JSON Mode**: Instructs the Gemini API to return a response in a strict JSON format, which maps directly to the `AIPrediction` interface. This avoids unreliable string parsing.
-   **Browser-Compatible**: Uses the standard `fetch` API, making it safe to use within a Chrome Extension's background service worker.
-   **Security**: The constructor requires an API key, and code comments strongly advise against hardcoding it, recommending user-based configuration and secure storage instead.

---

## 3. `maybeUseAI` Fallback Logic

The `maybeUseAI` function orchestrates the decision-making process between the deterministic engine and the AI fallback.

**Location**: `src/utils/predictionEngine.ts`

### Logic Flow:

1.  A deterministic prediction is generated first.
2.  If the deterministic confidence is **high** (`> 0.4`), the system trusts it and returns immediately. This is fast and cheap.
3.  If the deterministic confidence is **low** (`< 0.2`), the system invokes the AI provider passed to it.
4.  The AI's prediction is then merged with the deterministic results, typically by boosting its score and placing it at the top of the prediction list.
5.  If the AI call fails or confidence is in a middle range, the original deterministic result is returned as a safe default.

---

## 4. How to Implement `NovaProvider` (or any other provider)

Adding a new provider like Amazon Nova is straightforward thanks to the provider-agnostic design.

### Step-by-Step Guide:

1.  **Create the Provider Class**:
    -   Create a new file: `src/utils/novaProvider.ts`.
    -   Inside this file, define a `NovaProvider` class that implements the `AIProvider` interface.

    ```typescript
    // src/utils/novaProvider.ts
    import { AIProvider, CompactContext, AIPrediction } from '../types/ai';

    export class NovaProvider implements AIProvider {
      private apiKey: string;
      // May also need region, secret key, etc.

      constructor(apiKey: string /*, other credentials */) {
        this.apiKey = apiKey;
      }

      async predictNextAction(context: CompactContext): Promise<AIPrediction> {
        // 1. Format the prompt according to Nova's API requirements.
        const novaPrompt = `...`; // Format based on context

        // 2. Make a `fetch` call to the Amazon Nova API endpoint.
        //    This will likely involve AWS Signature V4 for authentication,
        //    which may require a small library or a backend proxy.
        const response = await fetch('NOVA_API_ENDPOINT', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // ...Authorization headers for Nova
          },
          body: JSON.stringify({ prompt: novaPrompt }),
        });

        const data = await response.json();

        // 3. Parse the response from Nova and map it to the AIPrediction interface.
        const prediction: AIPrediction = {
          predictedActionLabel: data.prediction.action, // Adjust to actual response structure
          reasoning: data.prediction.explanation,       // Adjust to actual response structure
          confidenceEstimate: data.prediction.confidence, // Adjust to actual response structure
        };

        return prediction;
      }
    }
    ```

2.  **Register the New Provider**:
    -   Open the provider factory file: `src/utils/aiProviderFactory.ts`.
    -   Import your new `NovaProvider`.
    -   Add it to the `providerRegistry`.

    ```typescript
    // src/utils/aiProviderFactory.ts
    import { AIProvider } from '../types/ai';
    import { GeminiProvider } from './geminiProvider';
    import { NovaProvider } from './novaProvider'; // <-- Import it

    const providerRegistry: Record<string, (apiKey: string) => AIProvider> = {
      gemini: (apiKey) => new GeminiProvider(apiKey),
      nova: (apiKey) => new NovaProvider(apiKey), // <-- Register it
    };
    // ... rest of the file
    ```

3.  **Select the Provider in Configuration**:
    -   The application can now select `"nova"` as the AI provider name from its configuration source, and the factory will automatically create and return a `NovaProvider` instance. No other code changes are needed.
