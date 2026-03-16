/**
 * Shared mutable state for the content script.
 * All modules import this object and mutate it directly (state.foo = bar).
 * Vite bundles everything into a single script so there is one instance.
 */

import type { AIProvider, FormFieldInfo } from "@/types/ai";
import type { AgentExecutor } from "@/utils/agentExecutor";

export const state = {
  // Agent global toggle
  isAgentGloballyEnabled: false,
  isAgentInitialized: false,

  // Form autofill tracking
  activeFormForAutofill: null as HTMLFormElement | null,
  activeFormFields: null as FormFieldInfo[] | null,

  // AI provider (undefined = not yet resolved, null = none available)
  aiProvider: undefined as AIProvider | null | undefined,

  // Current mission the agent is working toward
  currentMission: "",

  // Agent executor instance
  agentExecutor: null as AgentExecutor | null,
  isAgentExecutorActive: false,

  // Navigation tracking
  currentPageUrl: window.location.href,

  // Autofill AI cache — avoid redundant calls for the same form
  cachedAutofillData: null as Record<string, string> | null,
  cachedAutofillFieldsKey: null as string | null,
  isAutofillGenerating: false,

  // Set by executeForAgent when an action fails; consumed by buildPostActionObservation
  lastActionFailure: null as string | null,

  // One-shot steering hint typed by the user in the panel; consumed by the next predictForAgent call
  currentSteeringHint: null as string | null,
};
