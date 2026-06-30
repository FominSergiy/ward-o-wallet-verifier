import { Hono } from "hono";
import {
  type BlogPostFull,
  type BlogPostSummary,
  getPublishedPost,
  listPublishedPosts,
} from "../db/blog.ts";

// Public read API for the product site's /blog. Mounted at /api/blog, so the
// endpoints are GET /api/blog/posts and GET /api/blog/posts/:slug. Namespaced
// under /api so it never collides with the SPA's client-side /blog route in the
// dev proxy.

export interface BlogDeps {
  // Injection seams for offline tests; real callers leave them undefined.
  listPosts?: (limit?: number) => Promise<BlogPostSummary[]>;
  getPost?: (slug: string) => Promise<BlogPostFull | null>;
}

export function createBlogRouter(deps: BlogDeps = {}): Hono {
  const listPosts = deps.listPosts ?? listPublishedPosts;
  const getPost = deps.getPost ?? getPublishedPost;
  const router = new Hono();

  router.get("/posts", async (c) => {
    const posts = await listPosts();
    return c.json({ posts });
  });

  router.get("/posts/:slug", async (c) => {
    const post = await getPost(c.req.param("slug"));
    if (!post) {
      return c.json({ error: "not_found", message: "Post not found." }, 404);
    }
    return c.json(post);
  });

  return router;
}

/** Default instance for main.ts. */
export const blogRouter = createBlogRouter();
