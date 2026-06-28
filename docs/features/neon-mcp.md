# neon-mcp

**What:** Adds read/inspect access to the project's Neon Postgres from the agent via the Neon MCP server, plus the `neon` and `neon-postgres` Claude skills for guidance.

## Files

- `.mcp.json` — registered the `neon` MCP server: runs `mcp-remote https://mcp.neon.tech/mcp` with an `Authorization: Bearer ${NEON_API_KEY}` header, sourcing `.env` first.
- `.env.example` — documented `NEON_API_KEY` and `NEON_PROJECT_ID`.
- `.neon` — Neon init marker (`features: ["database"]`).
- `.claude/skills/neon/SKILL.md`, `.claude/skills/neon-postgres/SKILL.md` — Neon platform + Postgres skills (mirrored under `.agents/skills/`).
- `skills-lock.json` — skill lockfile.
- `CLAUDE.md` — added the "Neon MCP key — scope & allowed operations" subsection.

## Config

- `NEON_API_KEY` — project-scoped key bound to project `super-grass-68246474` (`ward-o-wallet-verifier`).
- `NEON_PROJECT_ID` — `super-grass-68246474`; must be passed explicitly on every `mcp__neon__*` call (the key can't enumerate projects).

## Notes

- The key is **project-scoped**: org/account-level ops (`list_projects`, `list_organizations`, `search`, etc.) return 404 and will always fail.
- Treat MCP as **read/inspect only**. Schema changes still go through `db/migrations/*.sql` + `deno task db:migrate` — not MCP migration tools. Never run destructive SQL without explicit approval.
- See CLAUDE.md → "Neon MCP key — scope & allowed operations" for the full allowed-operation list.
