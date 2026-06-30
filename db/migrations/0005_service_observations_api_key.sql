-- Per-key attribution on the live metrics table. Every paid service call in a
-- verify run is already written to service_observations (fire-and-forget, see
-- src/observability/observations.ts); this adds the issued-API-key id so we can
-- attribute spend/usage to the key that triggered the run. All rows in a run
-- share request_id, so (api_key_id, request_id) recovers "which requests belong
-- to which key".
--
-- Nullable + NO foreign key on purpose: the writer is a hot-path, error-swallowing
-- INSERT that must never block or fail on a missing/raced api_keys row. Anonymous
-- (keyless) runs leave it NULL.

ALTER TABLE service_observations
  ADD COLUMN IF NOT EXISTS api_key_id uuid;

CREATE INDEX IF NOT EXISTS service_observations_api_key_id_idx
  ON service_observations (api_key_id);
