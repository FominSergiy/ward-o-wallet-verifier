# first-blog-post

**What:** The inaugural post on the product site's `/blog` — "From hackathon to
product", an honest, condensed, engineer-oriented retrospective tracing Ward-o's
evolution from a 10-day hackathon win to an attempt at a real product (where
agentic development was effortless, where it cracked on infrastructure, and what
still needs a human in the loop).

**Files:**
- `docs/blog/from-hackathon-to-product.md` — canonical, version-controlled source
  of the post (frontmatter + Markdown body). This is the editable source of
  truth; the DB row is the published copy.
- No application code changed. The render path (`/blog` + `/blog/:slug`,
  `src/db/blog.ts` → `src/routes/blog.ts` → `web/src/components/BlogPost.tsx`
  with react-markdown) already shipped in the product pivot (#82).

**Config / external dependencies:**
- Published as one row in the prod Neon Postgres `blog_posts` table
  (project `super-grass-68246474`), inserted via an idempotent
  `INSERT … ON CONFLICT (slug) DO UPDATE` upsert (run through the Neon MCP).
  `published_at` is intentionally not overwritten on conflict, so re-publishing
  edits won't reorder the index.
- No env vars added. The deployed Cloudflare Pages frontend fetches the post
  live from the Deno Deploy backend (`/api/blog/posts`) — no redeploy needed to
  publish or edit a post.

**Notes / gotchas:**
- **Publishing a post = a DB write, not a code deploy.** There is no admin UI and
  no publish script; posts are authored by hand. To edit this post, change
  `docs/blog/from-hackathon-to-product.md` and re-run the upsert with the new
  `body_md` (the `ON CONFLICT` clause makes it safe to re-run).
- **Don't repeat the title as a leading `# H1` in `body_md`.** The `BlogPost`
  component already renders the post title from the `title` column; an `# H1` at
  the top of the body produces a duplicate title. This post's body starts with
  the italic intro line, not an H1. (Caught during the render-check.)
- The prod backend does not send CORS headers for the blog API, so a local
  render-check must go through the Vite dev proxy (server-side fetch), not a
  browser-direct `VITE_API_BASE_URL` to prod.
- Follow-up worth considering if blogging becomes regular: a `scripts/publish-blog.ts`
  that reads a `docs/blog/*.md` file (frontmatter + body) and upserts it, so
  every future post is one command instead of a hand-built SQL statement.
