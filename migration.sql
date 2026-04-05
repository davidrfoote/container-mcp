-- Model account health + usage tables for container-mcp v3 failover chains
-- Run against ops-db

-- Per-account health state (persisted across restarts)
CREATE TABLE IF NOT EXISTS model_account_health (
    account_id  TEXT PRIMARY KEY,
    healthy     BOOLEAN NOT NULL DEFAULT true,
    last_error  TEXT NOT NULL DEFAULT '',
    last_check  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-account daily usage tracking
CREATE TABLE IF NOT EXISTS model_account_usage (
    account_id  TEXT NOT NULL,
    usage_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    cost_usd    NUMERIC(12,4) NOT NULL DEFAULT 0,
    tokens      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, usage_date)
);

-- New column for CLI model observability (matches TS version)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_started_at TIMESTAMPTZ;
