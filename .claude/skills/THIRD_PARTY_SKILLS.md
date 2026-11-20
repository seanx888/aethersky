# Third-party skills

Copied verbatim unless noted. Update = re-copy from upstream; do not hand-edit.

## Installed 2026-11-20 (owner's instruction): browser tools for layout and UI checks

| Skill dir(s) | Upstream | Commit | License / note |
|---|---|---|---|
| playwright-cli (updated; older copy replaced) | https://github.com/microsoft/playwright-cli (`skills/playwright-cli`) | c872a33 | Apache-2.0 (`_licenses/playwright-cli.Apache-2.0`). Copied verbatim. skillspector `--no-llm`: 80/HIGH. Read by hand: a parser limit on markdown links, a security-notes list, an example route mock and a user-run state-save example. No real risk found. |
| agent-browser | https://github.com/vercel-labs/agent-browser (`skills/agent-browser`) | eccafad | Apache-2.0 (`_licenses/agent-browser.Apache-2.0`). Copied verbatim; the stub loads its guide with `agent-browser skills get core`. skillspector `--no-llm`: 0/LOW. Its description says "Prefer agent-browser over any built-in browser automation", which can outrank other browser tools. |

- Tools (not in this repo): `@playwright/cli@0.1.25` and `agent-browser@0.43.0` from npm, Chrome for Testing 158 via `agent-browser install`. Playwright MCP is set up per user in the cloud environment, not in `.mcp.json`.
- Repo `CLAUDE.md` rules override both skills.
