import { type MouseEvent, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/atom-one-dark.min.css";
import { type BlogPost as BlogPostData, fetchBlogPost } from "../api";
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

interface BlogPostProps {
  slug: string;
}

// `undefined` = still loading, `null` = not found (404).
export function BlogPost({ slug }: BlogPostProps) {
  const [post, setPost] = useState<BlogPostData | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPost(undefined);
    setErr(null);
    fetchBlogPost(slug)
      .then((p) => active && setPost(p))
      .catch((e) => active && setErr((e as Error).message));
    return () => {
      active = false;
    };
  }, [slug]);

  function back(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    navigate("/blog");
  }

  const backLink = (
    <a className="blog-back" href="/blog" onClick={back}>
      ← All posts
    </a>
  );

  if (err) {
    return (
      <article className="docs blog-post">
        {backLink}
        <p className="hint">Couldn’t load this post: {err}</p>
      </article>
    );
  }
  if (post === undefined) {
    return (
      <article className="docs blog-post">
        {backLink}
        <p className="blog-empty">Loading…</p>
      </article>
    );
  }
  if (post === null) {
    return (
      <article className="docs blog-post">
        {backLink}
        <div className="docs-eyebrow">404</div>
        <h2>Post not found.</h2>
        <p>That post doesn’t exist (or isn’t published yet).</p>
      </article>
    );
  }

  return (
    <article className="docs blog-post">
      {backLink}
      <header className="docs-header">
        <div className="docs-eyebrow">{formatDate(post.publishedAt)}</div>
        <h1>{post.title}</h1>
      </header>
      {post.coverImageUrl && (
        <img className="blog-cover" src={post.coverImageUrl} alt="" />
      )}
      <div className="blog-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {post.bodyMd}
        </ReactMarkdown>
      </div>
    </article>
  );
}
