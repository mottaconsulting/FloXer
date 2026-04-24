-- FloXer Initial Schema Migration
-- Run this in the Supabase SQL Editor: SQL Editor → New query → paste → Run
-- ============================================================


-- ------------------------------------------------------------
-- Table: xero_tokens
-- Stores one row per user per connected Xero organisation.
-- Tokens are upserted on each OAuth callback and auto-refreshed
-- by the backend when expires_at is in the past.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xero_tokens (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    expires_at      DOUBLE PRECISION NOT NULL,
    scope           TEXT,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, tenant_id)
);

ALTER TABLE xero_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own xero tokens"
    ON xero_tokens
    FOR ALL
    USING (auth.uid() = user_id);


-- ------------------------------------------------------------
-- Table: budget_rows
-- Stores one row per budget line per user.
-- data_category defaults to 'Budget' but may be overridden.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_rows (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    journal_date    DATE NOT NULL,
    account_type    TEXT,
    account_name    TEXT,
    account_code    TEXT,
    net_amount      NUMERIC,
    data_category   TEXT DEFAULT 'Budget'
);

ALTER TABLE budget_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own budget rows"
    ON budget_rows
    FOR ALL
    USING (auth.uid() = user_id);
