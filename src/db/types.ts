// Row types for the W0.1 schema (db/migrations/0001_init.sql). Hand-written to
// match the SQL column-for-column. postgres.js returns numeric columns as
// strings by default, so cost/price fields are typed `string | null`.

/** tenants — billable account (W1.1). */
export interface TenantRow {
  id: string;
  name: string;
  status: string;
  stripe_customer_id: string | null;
  created_at: Date;
}

/** api_keys — per-tenant credential (W1.1). */
export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** usage_events — metered billing/telemetry stream (W1.2). */
export interface UsageEventRow {
  id: string;
  tenant_id: string | null;
  request_id: string;
  route: string;
  phase: string | null;
  duration_ms: number | null;
  cost_usd: string | null;
  verdict: string | null;
  created_at: Date;
}

/** service_registry — curated x402 catalog (W0.2). score and last_vetted_at
 * added in 0002_service_registry_score.sql. */
export interface ServiceRegistryRow {
  id: string;
  resource: string;
  category: string;
  price_usdc: string | null;
  rationale: string | null;
  status: string;
  source: string | null;
  score: string;
  last_vetted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** service_observations — per-call outcomes (W0.8). severity_contribution
 * (W2.1) and outcome_label (W4) are forward-compat, dormant for now. */
export interface ServiceObservationRow {
  id: string;
  resource: string;
  request_id: string;
  status: string;
  duration_ms: number | null;
  cost_usd: string | null;
  error_code: string | null;
  empty_on_rich: boolean;
  severity_contribution: string | null;
  outcome_label: string | null;
  created_at: Date;
}

/** service_health_durable — mirror of ServiceHealth (W0.3). */
export interface ServiceHealthDurableRow {
  resource: string;
  ok: number;
  err: number;
  last_seen: Date | null;
  last_error: string | null;
  last_error_code: string | null;
  empty_on_rich: number;
  empty_on_rich_at: Date | null;
}
