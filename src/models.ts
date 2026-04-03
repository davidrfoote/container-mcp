export interface ModelDefinition {
  id: string;
  label: string;
  provider: "anthropic" | "zhipu" | "minimax";
  cliId: string;
  description?: string;
}

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    id: "sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    cliId: "claude-sonnet-4-6",
    description: "Anthropic Claude Sonnet 4.6 — default",
  },
  {
    id: "glm51",
    label: "GLM-5.1",
    provider: "zhipu",
    cliId: "glm-z1-flash",
    description: "Zhipu GLM-5.1",
  },
  {
    id: "glm5",
    label: "GLM-5 (API fallback)",
    provider: "zhipu",
    cliId: "glm-4-flash",
    description: "Zhipu GLM-5 API fallback",
  },
  {
    id: "minimax",
    label: "MiniMax",
    provider: "minimax",
    cliId: "minimax-text-01",
    description: "MiniMax Text",
  },
];

export const DEFAULT_MODEL_ID = "sonnet-4-6";

export function resolveModel(modelId?: string | null): ModelDefinition {
  if (modelId) {
    const found = MODEL_REGISTRY.find((m) => m.id === modelId);
    if (found) return found;
  }
  return MODEL_REGISTRY.find((m) => m.id === DEFAULT_MODEL_ID)!;
}
