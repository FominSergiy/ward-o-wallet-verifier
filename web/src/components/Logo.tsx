import type { MouseEvent } from "react";
import { WardoMascot } from "./WardoMascot";
import { navigate } from "../router";

interface LogoProps {
  currentPath?: string;
}

const LINKS = [
  { to: "/", label: "About" },
  { to: "/verify", label: "Verifier" },
  { to: "/blog", label: "Blog" },
];

export function Logo({ currentPath = "/" }: LogoProps) {
  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    e.preventDefault();
    navigate(to);
  }

  function isActive(to: string): boolean {
    if (to === "/") return currentPath === "/";
    return currentPath === to || currentPath.startsWith(to + "/");
  }

  return (
    <div className="logo-row">
      <div className="logo-text">
        <a
          href="/"
          onClick={(e) => go(e, "/")}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div className="logo">WARD-o</div>
        </a>
        <div className="tagline">wallet risk checks for agents that spend.</div>
      </div>
      <nav className="nav">
        {LINKS.map((l) => (
          <a
            key={l.to}
            href={l.to}
            className={isActive(l.to) ? "active" : ""}
            onClick={(e) => go(e, l.to)}
          >
            {l.label}
          </a>
        ))}
      </nav>
      <WardoMascot variant="neutral" size={88} className="logo-mascot" />
    </div>
  );
}
