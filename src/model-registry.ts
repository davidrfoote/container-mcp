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
  provider: "claude" | "google" | "openai" | "zai" | "minimax" | "other";
  tier: "primary" | "fallback";
  notes?: string;
}

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
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
    id: "glm-5.1",
    label: "GLM-5.1 (Coding)",
    provider: "zai",
    tier: "fallback",
    notes: "GLM-5.1 via ZAI coding endpoint (api/coding/paas/v4). Primary GLM model.",
  },
  {
    id: "glm-5",
    label: "GLM-5",
    provider: "zai",
    tier: "fallback",
    notes: "GLM-5 via ZAI coding endpoint. Fallback for glm-5.1.",
  },
  {
    id: "glm-5-turbo",
    label: "GLM-5-Turbo (Coding)",
    provider: "zai",
    tier: "fallback",
    notes: "GLM-5-Turbo via ZAI coding endpoint. Fast variant.",
  },
  {
    id: "glm-5.1-coding",
    label: "GLM-5.1 (Coding Plan)",
    provider: "zai",
    tier: "fallback",
    notes: "GLM-5.1 via ZAI coding plan endpoint (api/coding/paas/v4). Separate quota pool — use when standard API is exhausted.",
  },
  {
    id: "MiniMax-M2.7",
    label: "MiniMax M2.7",
    provider: "minimax",
    tier: "primary",
    notes: "MiniMax M2.7 via Anthropic-compatible endpoint. Fast and capable.",
  },
  {
    id: "MiniMax-M2.7-highspeed",
    label: "MiniMax M2.7 Highspeed",
    provider: "minimax",
    tier: "fallback",
    notes: "MiniMax M2.7 high-speed variant.",
  },
  {
    id: "MiniMax-M2.5",
    label: "MiniMax M2.5",
    provider: "minimax",
    tier: "fallback",
    notes: "MiniMax M2.5 via Anthropic-compatible endpoint.",
  },
];

export const DEFAULT_MODEL = "glm-5";

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
