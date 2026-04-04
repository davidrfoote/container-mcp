/**
 * model-registry.ts
 *
 * Self-contained model selection, health tracking, alias resolution, and
 * failover for container-mcp. Callers (code_task) just call resolveModel()
 * — all orchestration is internal.
 *
 * Auth ordering:
 *   Tier 1 (priority 1-9): OAuth/subscription models — preferred.
 *     When selected, ANTHROPIC_API_KEY is stripped from child env so the
 *     claude CLI is forced to use its stored OAuth session.
 *   Tier 2 (priority 10-19): API key models — fallback, billed per token.
 *   Tier 3 (priority 20+): Third-party OpenAI-compat models — last resort.
 *     Registered only when OPENAI_BASE_URL env var is set.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelDef {
  id: string
  aliases: string[]
  priority: number
  authTier: "oauth" | "api" | "compat"
  costHint?: string
  contextWindow?: number
  fallbackTo: string[]
}

export interface ResolvedModel {
  id: string
  aliases: string[]
  authTier: "oauth" | "api" | "compat"
  wasFailover: boolean
  failoverFrom?: string
  envOverrides: Record<string, string | undefined>
}

export interface ModelStatus {
  id: string
  aliases: string[]
  authTier: "oauth" | "api" | "compat"
  priority: number
  healthy: boolean | null
  lastChecked: string | null
  lastError?: string
  consecutiveFailures: number
  wouldBeSelected: boolean
}

// ── Internal health state ─────────────────────────────────────────────────────

interface HealthState {
  available: boolean
  checkedAt: number
  lastError?: string
  consecutiveFailures: number
}

const HEALTH_TTL_MS = 5 * 60 * 1000 // 5 minutes

const healthMap = new Map<string, HealthState>()

function getHealth(modelId: string): HealthState | null {
  const h = healthMap.get(modelId)
  if (!h) return null
  // TTL expired — treat as unknown
  if (Date.now() - h.checkedAt > HEALTH_TTL_MS) return null
  return h
}

// ── Catalog ───────────────────────────────────────────────────────────────────

function buildCatalog(): ModelDef[] {
  const catalog: ModelDef[] = [
    // Tier 1: OAuth (priority 1-9)
    {
      id: "claude-sonnet-4-6",
      aliases: ["sonnet", "default", "balanced", "coding", "standard"],
      priority: 1,
      authTier: "oauth",
      costHint: "$3/$15 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-haiku-4-5-20251001", "claude-opus-4-6"],
    },
    {
      id: "claude-haiku-4-5-20251001",
      aliases: ["haiku", "fast", "quick", "light"],
      priority: 2,
      authTier: "oauth",
      costHint: "$0.25/$1.25 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-sonnet-4-6"],
    },
    {
      id: "claude-opus-4-6",
      aliases: ["opus", "smart", "powerful", "complex", "deep"],
      priority: 3,
      authTier: "oauth",
      costHint: "$15/$75 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-sonnet-4-6"],
    },

    // Tier 2: API key (priority 10-19) — same model IDs, tried after oauth fails
    {
      id: "claude-sonnet-4-6",
      aliases: ["sonnet-api"],
      priority: 10,
      authTier: "api",
      costHint: "$3/$15 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-haiku-4-5-20251001", "claude-opus-4-6"],
    },
    {
      id: "claude-haiku-4-5-20251001",
      aliases: ["haiku-api"],
      priority: 11,
      authTier: "api",
      costHint: "$0.25/$1.25 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-sonnet-4-6"],
    },
    {
      id: "claude-opus-4-6",
      aliases: ["opus-api"],
      priority: 12,
      authTier: "api",
      costHint: "$15/$75 per M tokens",
      contextWindow: 200_000,
      fallbackTo: ["claude-sonnet-4-6"],
    },
  ]

  // Tier 3: OpenAI-compat (priority 20+) — only when OPENAI_BASE_URL is set
  if (process.env.OPENAI_BASE_URL) {
    const compatModelId = process.env.OPENAI_MODEL ?? "glm-4"
    catalog.push({
      id: compatModelId,
      aliases: ["compat", "external", "glm"],
      priority: 20,
      authTier: "compat",
      contextWindow: undefined,
      fallbackTo: [],
    })
  }

  return catalog
}

// Catalog is built once at module load. Priority-sorted for default selection.
const CATALOG: ModelDef[] = buildCatalog().sort((a, b) => a.priority - b.priority)

// ── Lookup helpers ────────────────────────────────────────────────────────────

function findByHint(hint: string): ModelDef | undefined {
  const lower = hint.toLowerCase()
  // Exact id match first (lowest priority wins if multiple share an id)
  const byId = CATALOG.find((m) => m.id === hint)
  if (byId) return byId
  // Alias match
  return CATALOG.find((m) => m.aliases.some((a) => a.toLowerCase() === lower))
}

function isUnhealthy(modelId: string): boolean {
  const h = getHealth(modelId)
  if (!h) return false // unknown = try it
  return !h.available
}

function buildEnvOverrides(authTier: "oauth" | "api" | "compat"): Record<string, string | undefined> {
  switch (authTier) {
    case "oauth":
      return { ANTHROPIC_API_KEY: undefined }
    case "api":
      return {}
    case "compat":
      return {
        ANTHROPIC_BASE_URL: process.env.OPENAI_BASE_URL,
        ANTHROPIC_API_KEY: process.env.OPENAI_API_KEY,
      }
  }
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Given a caller hint (model name, alias, or exact ID), resolve to the best
 * healthy model. Automatically skips unhealthy models and uses fallback chain.
 * If hint is undefined/null, uses highest-priority healthy model.
 */
export function resolveModel(hint?: string | null): ResolvedModel {
  let primary: ModelDef | undefined

  if (hint) {
    primary = findByHint(hint)
    if (!primary) {
      console.warn(`[model-registry] Unknown model hint "${hint}", falling back to default resolution`)
    }
  }

  // If no hint or hint not found, use highest-priority model
  if (!primary) {
    primary = CATALOG[0]
  }

  // Build candidate list: primary + its fallbacks (resolved from catalog)
  const candidates: ModelDef[] = [primary]
  for (const fbId of primary.fallbackTo) {
    const fb = CATALOG.find((m) => m.id === fbId && m.authTier === primary!.authTier)
      ?? CATALOG.find((m) => m.id === fbId)
    if (fb && !candidates.includes(fb)) {
      candidates.push(fb)
    }
  }
  // Also add api-tier variants as last-resort fallbacks
  for (const m of CATALOG) {
    if (!candidates.includes(m)) candidates.push(m)
  }

  // Walk candidates, skip unhealthy ones
  for (const candidate of candidates) {
    if (isUnhealthy(candidate.id)) {
      console.warn(`[model-registry] Skipping unhealthy model "${candidate.id}" (authTier=${candidate.authTier})`)
      continue
    }

    const wasFailover = candidate !== primary
    return {
      id: candidate.id,
      aliases: candidate.aliases,
      authTier: candidate.authTier,
      wasFailover,
      failoverFrom: wasFailover ? primary.id : undefined,
      envOverrides: buildEnvOverrides(candidate.authTier),
    }
  }

  // All models unhealthy — use primary anyway (best effort)
  console.warn("[model-registry] All candidates unhealthy, using primary model as best effort")
  return {
    id: primary.id,
    aliases: primary.aliases,
    authTier: primary.authTier,
    wasFailover: false,
    envOverrides: buildEnvOverrides(primary.authTier),
  }
}

/**
 * Mark a model as failed (called by code-task.ts on non-zero exit with error pattern).
 */
export function reportModelFailure(modelId: string, error: string): void {
  const existing = healthMap.get(modelId)
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1
  healthMap.set(modelId, {
    available: false,
    checkedAt: Date.now(),
    lastError: error,
    consecutiveFailures,
  })
  console.warn(`[model-registry] Model "${modelId}" marked unhealthy (failures=${consecutiveFailures}): ${error.slice(0, 200)}`)
}

/**
 * Mark a model as succeeded (called by code-task.ts on clean exit).
 */
export function reportModelSuccess(modelId: string): void {
  healthMap.set(modelId, {
    available: true,
    checkedAt: Date.now(),
    consecutiveFailures: 0,
  })
}

/**
 * For the get_model_status MCP tool — returns all models with health state.
 */
export function getModelStatus(): ModelStatus[] {
  // Determine what would be selected with no hint
  const wouldSelect = resolveModel(null)

  return CATALOG.map((m) => {
    const h = getHealth(m.id)
    return {
      id: m.id,
      aliases: m.aliases,
      authTier: m.authTier,
      priority: m.priority,
      healthy: h ? h.available : null,
      lastChecked: h ? new Date(h.checkedAt).toISOString() : null,
      lastError: h?.lastError,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      wouldBeSelected: wouldSelect.id === m.id && wouldSelect.authTier === m.authTier,
    }
  })
}

/**
 * Probe all models via direct API call (lightweight 1-token request).
 * Only works for oauth/api tier models with ANTHROPIC_API_KEY set, or if
 * the model can be reached via OPENAI_BASE_URL.
 * Returns probe results per model.
 */
export async function probeModels(): Promise<Array<{ id: string; ok: boolean; error?: string; latencyMs?: number }>> {
  const results: Array<{ id: string; ok: boolean; error?: string; latencyMs?: number }> = []
  const apiKey = process.env.ANTHROPIC_API_KEY

  // Deduplicate by id+authTier to avoid redundant probes
  const probed = new Set<string>()

  for (const m of CATALOG) {
    const key = `${m.id}::${m.authTier}`
    if (probed.has(key)) continue
    probed.add(key)

    const start = Date.now()

    if (m.authTier === "oauth" || m.authTier === "api") {
      if (!apiKey) {
        results.push({ id: m.id, ok: false, error: "ANTHROPIC_API_KEY not set" })
        continue
      }

      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: m.id,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(15_000),
        })

        const latencyMs = Date.now() - start

        if (resp.ok) {
          reportModelSuccess(m.id)
          results.push({ id: m.id, ok: true, latencyMs })
        } else if (resp.status === 429) {
          // Rate limited but model is reachable — treat as healthy
          reportModelSuccess(m.id)
          results.push({ id: m.id, ok: false, error: "rate_limited", latencyMs })
        } else if (resp.status === 401) {
          reportModelFailure(m.id, "unauthorized")
          results.push({ id: m.id, ok: false, error: "unauthorized", latencyMs })
        } else if (resp.status === 404) {
          reportModelFailure(m.id, "not_found")
          results.push({ id: m.id, ok: false, error: "not_found", latencyMs })
        } else {
          const text = await resp.text().catch(() => "")
          reportModelFailure(m.id, `http_${resp.status}: ${text.slice(0, 100)}`)
          results.push({ id: m.id, ok: false, error: `http_${resp.status}`, latencyMs })
        }
      } catch (err: any) {
        const latencyMs = Date.now() - start
        reportModelFailure(m.id, err.message)
        results.push({ id: m.id, ok: false, error: err.message, latencyMs })
      }
    } else if (m.authTier === "compat") {
      const baseUrl = process.env.OPENAI_BASE_URL
      const compatKey = process.env.OPENAI_API_KEY ?? ""

      if (!baseUrl) {
        results.push({ id: m.id, ok: false, error: "OPENAI_BASE_URL not set" })
        continue
      }

      try {
        const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${compatKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: m.id,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(15_000),
        })

        const latencyMs = Date.now() - start

        if (resp.ok) {
          reportModelSuccess(m.id)
          results.push({ id: m.id, ok: true, latencyMs })
        } else {
          const text = await resp.text().catch(() => "")
          reportModelFailure(m.id, `http_${resp.status}: ${text.slice(0, 100)}`)
          results.push({ id: m.id, ok: false, error: `http_${resp.status}`, latencyMs })
        }
      } catch (err: any) {
        const latencyMs = Date.now() - start
        reportModelFailure(m.id, err.message)
        results.push({ id: m.id, ok: false, error: err.message, latencyMs })
      }
    }
  }

  return results
}
