-- W0.1 — initial schema for the wallet-verifier reputation/billing backend.
-- Plain portable Postgres only (no Neon/Supabase-specific features) so the
-- schema stays host-agnostic. Applied by scripts/migrate.ts via the
-- `schema_migrations` bookkeeping table; safe to re-run (IF NOT EXISTS).
--
-- Forward-compat note: nullable columns flagged below are dormant until the
-- workstream that uses them lands (W1.3 stripe, W2.1 severity, W4 outcomes).

-- gen_random_uuid() lives in pgcrypto on older servers; Neon ships it core,
-- but enable the extension defensively for portability.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenants — the billable account (W1.1). stripe_customer_id is nullable until
-- Stripe billing lands (W1.3).
CREATE TABLE IF NOT EXISTS tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active',
  stripe_customer_id text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- API keys — per-tenant credentials for the MCP/HTTP rails (W1.1). Only the
-- hash is stored; key_prefix is the human-readable lookup/display fragment.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_id_idx ON api_keys (tenant_id);

-- Usage events — the metered billing/telemetry stream (W1.2). Columns mirror
-- the telemetry fields emitted in src/agent/events.ts (request_id,
-- duration_ms, cost_usd). tenant_id is nullable for un-attributed/anonymous
-- calls (e.g. the public playground).
CREATE TABLE IF NOT EXISTS usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants (id) ON DELETE SET NULL,
  request_id  text NOT NULL,
  route       text NOT NULL,
  phase       text,
  duration_ms integer,
  cost_usd    numeric(18, 8),
  verdict     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_id_idx ON usage_events (tenant_id);
CREATE INDEX IF NOT EXISTS usage_events_request_id_idx ON usage_events (request_id);
CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events (created_at);

-- Service registry — the curated x402 service catalog (W0.2). status gates
-- whether the ranker considers the entry (active/blocked/vetting).
CREATE TABLE IF NOT EXISTS service_registry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    text NOT NULL UNIQUE,
  category    text NOT NULL,
  price_usdc  numeric(18, 8),
  rationale   text,
  status      text NOT NULL DEFAULT 'vetting',
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Service observations — per-call outcomes feeding the reputation moat (W0.8).
-- severity_contribution (W2.1) and outcome_label (W4) are forward-compat
-- nullable columns, dormant until those workstreams land.
CREATE TABLE IF NOT EXISTS service_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource              text NOT NULL,
  request_id            text NOT NULL,
  status                text NOT NULL,
  duration_ms           integer,
  cost_usd              numeric(18, 8),
  error_code            text,
  empty_on_rich         boolean NOT NULL DEFAULT false,
  severity_contribution numeric(18, 8),
  outcome_label         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_observations_resource_idx ON service_observations (resource);
CREATE INDEX IF NOT EXISTS service_observations_request_id_idx ON service_observations (request_id);

-- Durable service health — column-for-column mirror of the ServiceHealth
-- interface in src/discovery/health_store.ts:10, so W0.3 can lift the JSON
-- store into Postgres without reshaping the data.
CREATE TABLE IF NOT EXISTS service_health_durable (
  resource         text PRIMARY KEY,
  ok               integer NOT NULL DEFAULT 0,
  err              integer NOT NULL DEFAULT 0,
  last_seen        timestamptz,
  last_error       text,
  last_error_code  text,
  empty_on_rich    integer NOT NULL DEFAULT 0,
  empty_on_rich_at timestamptz
);
