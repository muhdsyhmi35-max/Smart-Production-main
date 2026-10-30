# Decisions (ADR log)

Append-only. To change a decision, add a new ADR that supersedes an older one.

## ADR-001 — AI team uses Cursor + GitHub only (MVP)

- **Date:** 2026-10-29
- **Status:** Accepted
- **Context:** User pays ChatGPT Go only; Claude/Gemini are free apps. ChatGPT Go does not provide OpenAI API automation.
- **Decision:** Implement AI collaboration as Cursor Cloud Agent + GitHub docs/Issues/PRs. Defer paid multi-model APIs.
- **Consequences:** Roles are sequential passes in one agent. Independent multi-vendor review requires future API spend or manual use of free chat UIs outside the loop.
