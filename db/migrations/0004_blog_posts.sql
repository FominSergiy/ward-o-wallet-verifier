-- Blog posts — the technical write-ups that feed the product site's /blog
-- section. Authored by hand (direct INSERT) for now; no admin UI. body_md holds
-- Markdown (technical posts, occasional images via Markdown image syntax or the
-- cover_image_url). The frontend renders it; the API only stores and serves.
--
-- Plain portable Postgres (no Neon-specific features). Safe to re-run.

CREATE TABLE IF NOT EXISTS blog_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  excerpt         text,
  body_md         text NOT NULL,
  cover_image_url text,
  published       boolean NOT NULL DEFAULT true,
  published_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The index the list query rides: published rows, newest first.
CREATE INDEX IF NOT EXISTS blog_posts_published_at_idx
  ON blog_posts (published_at DESC);
