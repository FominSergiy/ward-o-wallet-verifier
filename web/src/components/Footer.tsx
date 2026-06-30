import type { MouseEvent } from "react";
import { navigate } from "../router";
import { BUYMEACOFFEE_URL, GITHUB_URL, LINKEDIN_URL } from "../config";

export function Footer() {
  function goDocs(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    navigate("/docs");
  }

  return (
    <footer className="app-footer">
      <div className="footer-links">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        <a href={LINKEDIN_URL} target="_blank" rel="noopener noreferrer">
          LinkedIn
        </a>
        <a href={BUYMEACOFFEE_URL} target="_blank" rel="noopener noreferrer">
          Buy me a coffee
        </a>
        <a href="/docs" onClick={goDocs}>
          Architecture
        </a>
      </div>
      <div className="footer-credit">
        Powered by{" "}
        <a href="https://agnic.ai" target="_blank" rel="noopener noreferrer">
          Agnic
        </a>{" "}
        · Built by Sergiy Fomin
      </div>
    </footer>
  );
}
