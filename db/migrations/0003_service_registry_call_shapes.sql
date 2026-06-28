-- Fan-out reliability fix (W0.11) — move the per-service call shape into
-- service_registry so the DB becomes the single source of truth for HOW to
-- invoke each service. Previously the call shape lived only in
-- data/call_recipes.json (4 sample recipes), joined by service_id at selection
-- time; that left the 30 discovered probation candidates uninvokable.
--
-- All columns nullable (legacy rows + the offline replay path never read them)
-- and NO index: these are read-only projection data, never used in WHERE /
-- ORDER BY. Measured at 89–150 bytes/row (~120 avg) — ~120KB at 1,000 services.
-- jsonb for the structured param/body fields, text for the scalar method/body_type.

ALTER TABLE service_registry
  ADD COLUMN IF NOT EXISTS method       text,
  ADD COLUMN IF NOT EXISTS query_params jsonb,
  ADD COLUMN IF NOT EXISTS path_params  jsonb,
  ADD COLUMN IF NOT EXISTS body_schema  jsonb,
  ADD COLUMN IF NOT EXISTS body_type    text;
