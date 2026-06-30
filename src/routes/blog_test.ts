import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { type BlogDeps, createBlogRouter } from "./blog.ts";
import type { BlogPostFull, BlogPostSummary } from "../db/blog.ts";

const summaries: BlogPostSummary[] = [
  {
    slug: "newer",
    title: "Newer",
    excerpt: null,
    coverImageUrl: null,
    publishedAt: "2026-02-01T00:00:00.000Z",
  },
  {
    slug: "older",
    title: "Older",
    excerpt: "x",
    coverImageUrl: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
  },
];

function appWith(deps: BlogDeps): Hono {
  const app = new Hono();
  app.route("/api/blog", createBlogRouter(deps));
  return app;
}

Deno.test("GET /api/blog/posts returns posts in the order given", async () => {
  const app = appWith({
    listPosts: () => Promise.resolve(summaries),
    getPost: () => Promise.resolve(null),
  });
  const res = await app.request("/api/blog/posts");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.posts.map((p: BlogPostSummary) => p.slug), [
    "newer",
    "older",
  ]);
});

Deno.test("GET /api/blog/posts/:slug returns the matching post", async () => {
  const post: BlogPostFull = {
    slug: "hi",
    title: "Hi",
    excerpt: null,
    coverImageUrl: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    bodyMd: "# Hi\n\nbody",
  };
  const app = appWith({
    listPosts: () => Promise.resolve([]),
    getPost: (slug) => Promise.resolve(slug === "hi" ? post : null),
  });
  const res = await app.request("/api/blog/posts/hi");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).bodyMd, "# Hi\n\nbody");
});

Deno.test("GET /api/blog/posts/:slug 404s on a miss", async () => {
  const app = appWith({
    listPosts: () => Promise.resolve([]),
    getPost: () => Promise.resolve(null),
  });
  const res = await app.request("/api/blog/posts/missing");
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});
