# Agent Rules (Draft — not yet activated)

Human-owned. Change only via PR you approve.

## Active mode

**Current:** Planning only. No autonomous multi-agent runtime is enabled yet.

**Intended MVP mode:** Cursor Cloud Agent implements from GitHub Issues / your instructions; GitHub is source of truth.

## Roles

| Role | Runtime | Authority |
|------|---------|-----------|
| Coordinator | Cursor (plan) or OpenAI API (later) | Break down tasks; write reports; may not merge to `main` |
| Architect / Reviewer | Anthropic API or second Cursor pass | Findings only; no silent code edits |
| Researcher | Gemini API or Cursor web tools | Research notes only |
| Implementer | Cursor Cloud Agent | Sole writer of application code on feature branches |
| Human | You | Approve plans (policy), merges, deploys, destructive actions |

## Hard stops

Stop and ask the human when:

- Acceptance criteria unmet after N correction iterations (default N=3)
- Credentials / permissions missing
- Agents disagree on a safe approach
- Production deploy or destructive action requested
- Tests could not be run but success is claimed

## Honesty

Never fabricate tool results, test outcomes, or completed actions.
