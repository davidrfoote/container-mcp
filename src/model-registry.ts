/**
 * MiniMax Model Routing
 *
 * When using the MiniMax model, requests are routed to api.minimax.io/anthropic
 * instead of the default Anthropic endpoint. The ANTHROPIC_API_KEY environment
 * variable is deleted because MiniMax uses its own API key for authentication.
 */

/**
 * Model Registry — canonical source of available Claude CLI models.
 *
 * Each entry describes:
 * - id:        CLI argument value (--model <id>)
 * - label:     Human-friendly display name in dev-session-app UI
 * - provider:  claude | google | openai | other
 * - tier:     primary (preferred) | fallback (use when primary is unavailable)
 * - notes:     Compatibility notes (e.g. "requires claude CLI 1.0.50+")
 *
 * To add a new model, append it here — no other code changes required.
 */

export interface ModelEntry {
  id: string;
  label: string;
  provider: "claude" | "google" | "openai" | "other";
  tier: "primary" | "fallback";
  notes?: string;
}

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: "sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "claude",
    tier: "primary",
    notes: "Default. Best balance of speed and capability for most tasks.",
  },
  {
    id: "haiku-4",
    label: "Claude Haiku 4",
    provider: "claude",
    tier: "fallback",
    notes: "Fast, low cost. Good for simple/repetitive tasks.",
  },
  {
    id: "glm-5-api",
    label: "GLM-5 (API)",
    provider: "google",
    tier: "fallback",
    notes: "Google GLM-5 via API. Requires Zhipu AI API key in environment.",
  },
  {
    id: "glm-5-flash",
    label: "GLM-5 Flash (API)",
    provider: "google",
    tier: "fallback",
    notes: "Fast GLM-5 variant. Low latency, lower cost.",
  },
  {
    id: "minimax",
    label: "MiniMax",
    provider: "other",
    tier: "fallback",
    notes: "MiniMax MoE model. Requires MiniMax API key in environment.",
  },
];

export const DEFAULT_MODEL = "sonnet-4-6";

/** Returns the ModelEntry for a given id, or undefined. */
export function getModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** Returns all models in a specific tier. */
export function getModelsByTier(tier: "primary" | "fallback"): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.tier === tier);
}

/** Returns the ModelEntry for the default model. */
export function getDefaultModel(): ModelEntry {
  return getModel(DEFAULT_MODEL) ?? MODEL_REGISTRY[0];
}

/** Validates a model id — returns true if registered. */
export function isValidModel(id: string): boolean {
  return MODEL_REGISTRY.some((m) => m.id === id);
}

/** Returns a list of model ids. */
export function listModelIds(): string[] {
  return MODEL_REGISTRY.map((m) => m.id);
}
