-- W0.2 — add score and last_vetted_at to service_registry.
-- score feeds the W0.9 score-based ranker; seeded entries start at 1.0 (perfect).
-- last_vetted_at records when the entry was last manually or programmatically vetted.

ALTER TABLE service_registry
  ADD COLUMN IF NOT EXISTS score          numeric(5, 4) NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS last_vetted_at timestamptz;
