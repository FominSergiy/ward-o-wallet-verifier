// Row types for the W0.1 schema (db/migrations/0001_init.sql). Hand-written to
// match the SQL column-for-column. postgres.js returns numeric columns as
// strings by default, so cost/price fields are typed `string | null`.

import type { ObservationStatus, ServiceStatus } from "./enums.ts";

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
 * added in 0002_service_registry_score.sql; the call-shape columns (method,
 * query_params, path_params, body_schema, body_type) added in
 * 0003_service_registry_call_shapes.sql — all nullable, the DB-as-single-source
 * -of-truth for HOW to invoke each service (W0.11). postgres.js returns jsonb
 * columns as already-parsed JS values. */
export interface ServiceRegistryRow {
  id: string;
  resource: string;
  category: string;
  price_usdc: string | null;
  rationale: string | null;
  status: ServiceStatus;
  source: string | null;
  score: string;
  last_vetted_at: Date | null;
  method: string | null;
  query_params: Record<string, unknown> | null;
  path_params: Record<string, unknown> | null;
  body_schema: unknown | null;
  body_type: string | null;
  created_at: Date;
  updated_at: Date;
}

/** service_observations — per-call outcomes (W0.8). severity_contribution
 * (W2.1) and outcome_label (W4) are forward-compat, dormant for now. api_key_id
 * (0005) attributes the call to the issued API key that triggered the run;
 * NULL for anonymous/keyless runs. */
export interface ServiceObservationRow {
  id: string;
  resource: string;
  request_id: string;
  status: ObservationStatus;
  duration_ms: number | null;
  cost_usd: string | null;
  error_code: string | null;
  empty_on_rich: boolean;
  severity_contribution: string | null;
  outcome_label: string | null;
  api_key_id: string | null;
  created_at: Date;
}

/** blog_posts — hand-authored technical write-ups for the product site's /blog
 * (0004_blog_posts.sql). body_md is Markdown; published/published_at gate and
 * order the public list. */
export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  cover_image_url: string | null;
  published: boolean;
  published_at: Date;
  created_at: Date;
  updated_at: Date;
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
