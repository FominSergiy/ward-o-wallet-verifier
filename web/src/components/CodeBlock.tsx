import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/atom-one-dark.min.css";

let registered = false;
function ensureLangs() {
  if (registered) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("typescript", typescript);
  registered = true;
}

interface CodeBlockProps {
  lang: string;
  children: string;
}

/** Shared dark code block — same chrome as the docs page, plus bash for curl. */
export function CodeBlock({ lang, children }: CodeBlockProps) {
  ensureLangs();
  const highlighted = hljs.highlight(children.trim(), {
    language: lang,
    ignoreIllegals: true,
  }).value;
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <span>{lang}</span>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </figure>
  );
}
