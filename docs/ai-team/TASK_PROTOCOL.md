# Task protocol (MVP)

Use this for every AI team task until a later orchestrator exists.

## 1. Intake

Record in the Issue (or PR description):

- Objective (one sentence)
- Acceptance criteria (checklist)
- Out of scope
- Risk level: `docs` | `safe-code` | `feature` | `deploy`

## 2. Context load (required)

Before editing, read:

1. `docs/ai-team/AGENTS.md`
2. `docs/PROJECT_BRIEF.md`
3. `docs/REQUIREMENTS.md` (Approved section)
4. `docs/DECISIONS.md`
5. `docs/TASKS.md`
6. Relevant source files only

Do not invent requirements. If unclear, ask or mark assumptions explicitly.

## 3. Plan pass

Write a short plan:

- Subtasks
- Files likely touched
- Tests / validation to run
- Whether human approval is needed before coding (`feature` / `deploy` = yes)

## 4. Implement pass

- Work on a `cursor/...` branch
- Change only necessary files
- Prefer targeted edits over rewrites
- Update `docs/TESTING.md` with real commands and results

## 5. Review pass (same agent, adversarial)

Check for:

- Requirements compliance
- Bugs / edge cases
- Security / data integrity
- Compatibility with existing features
- Test gaps

Record findings as:

| Severity | Finding | File | Action |
|----------|---------|------|--------|
| blocker / major / minor / note | … | path | fix / defer / ask human |

## 6. Fix loop

For each legitimate blocker/major:

1. Fix narrowly
2. Re-run relevant validation
3. Re-review

Stop at **3** loops or when only minor/notes remain (or human must decide).

## 7. Completion report

Copy `templates/COMPLETION_REPORT.md` into the PR body (or Issue comment). Never claim success if tests were skipped — say so.
