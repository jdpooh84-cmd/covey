-- PulseCore v8.0 — Postgres schema
-- Run once against your Render Postgres database.
-- The server also runs CREATE TABLE IF NOT EXISTS on startup,
-- so this file is provided for manual inspection / CI migrations.

CREATE TABLE IF NOT EXISTS pc_users (
  id                     TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email                  TEXT        UNIQUE NOT NULL,
  password_hash          TEXT        NOT NULL,
  name                   TEXT        NOT NULL DEFAULT '',
  tier                   TEXT        NOT NULL DEFAULT 'free'
                                     CHECK (tier IN ('free','pro','agency')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  usage                  JSONB       NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pc_users_email_idx  ON pc_users (LOWER(email));
CREATE INDEX IF NOT EXISTS pc_users_stripe_sub ON pc_users (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION pc_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pc_users_updated_at') THEN
    CREATE TRIGGER pc_users_updated_at
    BEFORE UPDATE ON pc_users
    FOR EACH ROW EXECUTE FUNCTION pc_set_updated_at();
  END IF;
END $$;
