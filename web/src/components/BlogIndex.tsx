import { type MouseEvent, useEffect, useState } from "react";
import { type BlogSummary, fetchBlogPosts } from "../api";
import { navigate } from "../router";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BlogIndex() {
  const [posts, setPosts] = useState<BlogSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchBlogPosts()
      .then((p) => active && setPosts(p))
      .catch((e) => active && setErr((e as Error).message));
    return () => {
      active = false;
    };
  }, []);

  function open(e: MouseEvent<HTMLAnchorElement>, slug: string) {
    e.preventDefault();
    navigate(`/blog/${slug}`);
  }

  return (
    <article className="docs blog-index">
      <header className="docs-header">
        <div className="docs-eyebrow">Blog</div>
        <h1>Notes &amp; write-ups</h1>
        <p className="docs-lede">
          Technical posts on how WARD-o works and what I learn building it.
        </p>
      </header>

      {err && <p className="hint">Couldn’t load posts: {err}</p>}
      {!err && posts === null && <p className="blog-empty">Loading…</p>}
      {!err && posts && posts.length === 0 && (
        <p className="blog-empty">No posts yet — check back soon.</p>
      )}

      {posts?.map((p) => (
        <a
          key={p.slug}
          className="blog-card"
          href={`/blog/${p.slug}`}
          onClick={(e) => open(e, p.slug)}
        >
          {p.coverImageUrl && (
            <img className="blog-card-cover" src={p.coverImageUrl} alt="" />
          )}
          <div className="blog-card-body">
            <div className="blog-card-date">{formatDate(p.publishedAt)}</div>
            <h3 className="blog-card-title">{p.title}</h3>
            {p.excerpt && <p className="blog-card-excerpt">{p.excerpt}</p>}
          </div>
        </a>
      ))}
    </article>
  );
}
