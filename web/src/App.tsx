import type { MouseEvent, ReactNode } from "react";
import { Logo } from "./components/Logo";
import { Footer } from "./components/Footer";
import { DocsPage } from "./components/DocsPage";
import { VerifierApp } from "./components/VerifierApp";
import { LandingPage } from "./components/LandingPage";
import { BlogIndex } from "./components/BlogIndex";
import { BlogPost } from "./components/BlogPost";
import { navigate, useLocation } from "./router";

function NotFound() {
  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    e.preventDefault();
    navigate(to);
  }
  return (
    <div className="notfound">
      <div className="docs-eyebrow">404</div>
      <h2>Nothing here.</h2>
      <p>
        Try the{" "}
        <a href="/" onClick={(e) => go(e, "/")}>
          home page
        </a>, the{" "}
        <a href="/verify" onClick={(e) => go(e, "/verify")}>
          verifier
        </a>, or the{" "}
        <a href="/blog" onClick={(e) => go(e, "/blog")}>
          blog
        </a>.
      </p>
    </div>
  );
}

function route(path: string): ReactNode {
  if (path === "/") return <LandingPage />;
  if (path === "/verify") return <VerifierApp />;
  if (path === "/blog") return <BlogIndex />;
  if (path.startsWith("/blog/")) {
    return <BlogPost slug={decodeURIComponent(path.slice("/blog/".length))} />;
  }
  if (path === "/docs") return <DocsPage />;
  return <NotFound />;
}

export function App() {
  const path = useLocation();
  return (
    <div className="app">
      <Logo currentPath={path} />
      {route(path)}
      <Footer />
    </div>
  );
}
