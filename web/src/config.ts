// Product-page configuration: outbound links + the optional web-ui attribution
// key. Edit the link constants to your own handles.
//
// WEB_KEY is sent by the UI as a Bearer on verify/discover requests so its paid
// runs are attributed in service_observations. It is NOT a secret — it ships in
// the client bundle; it only buys attribution + revocation. Provision it once
// (`curl -X POST <api>/request-key -d '{"label":"web-ui"}'`) and set
// VITE_WARDO_WEB_KEY in the build env. Empty → web runs are anonymous.

export const GITHUB_URL =
  "https://github.com/FominSergiy/ward-o-wallet-verifier";

export const LINKEDIN_URL = "https://www.linkedin.com/in/sergiy-fomin/";

// Buy Me a Coffee page — replace the handle with your own BMAC username.
export const BUYMEACOFFEE_URL = "https://buymeacoffee.com/sergiy_fomin";

export const WEB_KEY =
  (import.meta.env.VITE_WARDO_WEB_KEY as string | undefined)?.trim() ?? "";

// Public backend base URL (Deno Deploy in prod; "" same-origin in dev via the
// Vite proxy). Used to render copy-pasteable curl / MCP-config snippets.
export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";
