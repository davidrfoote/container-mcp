-- Add triggered_by_name and triggered_by_slack_user_id columns to sessions table
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS triggered_by_name text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS triggered_by_slack_user_id text;
