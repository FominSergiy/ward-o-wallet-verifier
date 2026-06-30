// Read access for blog_posts (0004). The product site's /blog reads through
// these two functions; posts are authored by hand (direct INSERT). With no
// DATABASE_URL the no-op client returns [], so the list degrades to empty and a
// single-post lookup to null — the frontend renders an empty/404 state, never a
// crash.

import { getDb } from "./client.ts";
import type { BlogPostRow } from "./types.ts";

/** Card-level fields for the /blog index (no body). */
export interface BlogPostSummary {
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  publishedAt: string;
}

/** Full post for /blog/:slug, including the Markdown body. */
export interface BlogPostFull extends BlogPostSummary {
  bodyMd: string;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value != null ? String(value) : "";
}

function toSummary(
  row: Pick<
    BlogPostRow,
    "slug" | "title" | "excerpt" | "cover_image_url" | "published_at"
  >,
): BlogPostSummary {
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url,
    publishedAt: isoOf(row.published_at),
  };
}

/** Published posts, newest first (rides blog_posts_published_at_idx). */
export async function listPublishedPosts(
  limit = 50,
): Promise<BlogPostSummary[]> {
  const db = getDb();
  const rows = (await db`
    SELECT slug, title, excerpt, cover_image_url, published_at
    FROM blog_posts
    WHERE published = true
    ORDER BY published_at DESC
    LIMIT ${limit}
  `) as Pick<
    BlogPostRow,
    "slug" | "title" | "excerpt" | "cover_image_url" | "published_at"
  >[];
  return rows.map(toSummary);
}

/** One published post by slug, or null if missing/unpublished. */
export async function getPublishedPost(
  slug: string,
): Promise<BlogPostFull | null> {
  const db = getDb();
  const rows = (await db`
    SELECT slug, title, excerpt, cover_image_url, published_at, body_md
    FROM blog_posts
    WHERE slug = ${slug} AND published = true
    LIMIT 1
  `) as BlogPostRow[];
  const row = rows[0];
  if (!row) return null;
  return { ...toSummary(row), bodyMd: row.body_md };
}
