-- Model account health and usage tracking for failover chains
-- Persists per-account health + daily usage so it survives restarts

CREATE TABLE IF NOT EXISTS model_account_health (
    account_id       TEXT        NOT NULL,
    provider         TEXT        NOT NULL,
    tier             TEXT        NOT NULL,
    healthy          BOOLEAN     NOT NULL DEFAULT true,
    last_error       TEXT,
    last_checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECKED_until    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
    PRIMARY KEY (account_id, provider, tier)
);

CREATE TABLE IF NOT EXISTS model_account_usage (
    account_id       TEXT        NOT NULL,
    provider         TEXT        NOT NULL,
    tier             TEXT        NOT NULL,
    date             DATE        NOT NULL DEFAULT CURRENT_DATE,
    requests         INTEGER     NOT NULL DEFAULT 0,
    input_tokens     BIGINT      NOT NULL DEFAULT 0,
    output_tokens    BIGINT      NOT NULL DEFAULT 0,
    cost_usd         NUMERIC(12, 6) NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, provider, tier, date)
);

-- Index for daily budget lookups
CREATE INDEX IF NOT EXISTS idx_model_account_usage_date
    ON model_account_usage (account_id, provider, tier, date);
