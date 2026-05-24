import type { MouseEvent } from "react";
import { WardoMascot } from "./WardoMascot";
import { navigate } from "../router";

interface LogoProps {
  currentPath?: string;
}

export function Logo({ currentPath = "/" }: LogoProps) {
  function go(e: MouseEvent<HTMLAnchorElement>, to: string) {
    e.preventDefault();
    navigate(to);
  }

  return (
    <div className="logo-row">
      <div className="logo-text">
        <div className="logo">WARD-o</div>
        <div className="tagline">wallet risk verification, on demand.</div>
      </div>
      <nav className="nav">
        <a
          href="/"
          className={currentPath === "/" ? "active" : ""}
          onClick={(e) => go(e, "/")}
        >
          Home
        </a>
        <a
          href="/docs"
          className={currentPath === "/docs" ? "active" : ""}
          onClick={(e) => go(e, "/docs")}
        >
          Docs
        </a>
      </nav>
      <WardoMascot variant="neutral" size={88} className="logo-mascot" />
    </div>
  );
}
