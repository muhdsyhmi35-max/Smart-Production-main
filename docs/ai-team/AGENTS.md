# Agent Rules — Cursor + GitHub MVP

Human-owned. Change only via PR you approve.

## Active mode

**MVP (Option A):** One Cursor Cloud Agent plays coordinator + implementer + self-review.  
GitHub is the source of truth. **No** ChatGPT / Claude / Gemini API orchestration.

ChatGPT Go may be used by the human outside this loop; paste useful conclusions into Issues/docs if they should persist.

## Role simulation (same agent, different passes)

| Pass | Acts as | Output |
|------|---------|--------|
| 1 Plan | Coordinator | Task checklist in Issue / `TASKS.md` |
| 2 Research (optional) | Researcher | Short notes under `docs/ai-team/research/` |
| 3 Design check | Architect | Risks + approach in plan before edits |
| 4 Implement | Implementer | Branch + code/docs + tests |
| 5 Review | Reviewer | Findings with severity + file refs |
| 6 Fix | Implementer | Targeted fixes ≤ N times |
| 7 Report | Coordinator | `COMPLETION_REPORT` template filled |

## Authority

| Action | Allowed? |
|--------|----------|
| Edit on feature branch + open PR | Yes |
| Push / merge to `main` | No — human merges |
| Production Netlify / Firebase deploy | No — human only |
| Invent requirements | No — update `REQUIREMENTS.md` via PR for approval |
| Destructive git/firebase/netlify | No without human approval |
| Fabricate test results | Never |

## Stop conditions

Stop and ask the human when:

- Acceptance criteria unmet after **N=3** correction iterations
- Credentials / permissions missing
- Safe approach is unclear
- Production deploy or destructive action requested
- Tests could not be run but success would be claimed

## How to start a task

1. You: open a GitHub Issue (or Cursor chat) with the objective.
2. Agent: follow `TASK_PROTOCOL.md`.
3. Agent: open a PR; fill completion report.
4. You: review, merge, deploy if needed.
