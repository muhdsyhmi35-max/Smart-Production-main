# Open Questions

## Resolved

1. **Budget / APIs:** **Cursor + GitHub only.** No paid OpenAI / Anthropic / Gemini API orchestration. (ChatGPT Go only; others free.) See `BUDGET_DECISION.md`.
2. **Paid AI products:** ChatGPT Go only. Claude / Gemini free. Cursor Cloud Agents available in this environment (plan tier not fully verified from the agent).

## Still open (defaults applied until you change them)

| # | Question | Default if you say nothing |
|---|----------|----------------------------|
| 3 | Approval style | Auto-implement low-risk **docs/test** changes; ask before app/feature/deploy changes |
| 4 | Correction loop limit | **3** |
| 5 | First pilot task | Add AI-team memory docs + run protocol once (this PR) |
| 6 | Deploy policy | **Always human-approve** Netlify/Firebase deploy |
| 7 | Where to build | **This repo** (`Smart-Production-main`) |
| 8 | Notifications | **GitHub only** (PR + Issue comments) |

Reply if you want any default changed.
