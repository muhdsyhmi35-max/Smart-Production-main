# Testing

## Manual (frontend)

1. Open `index.html` in a browser.
2. Confirm layout loads (no server required for static shell).
3. Firebase features need valid `FIREBASE_CONFIG` / `databaseURL` in `script.js` — do not invent credentials.

## Backend

See `functions/package.json` scripts and `DEPLOY.md`. Only run Firebase deploys with human approval.

## AI team validation checklist

When finishing a task, record:

| Date | Task | Command / check | Result |
|------|------|-----------------|--------|
| 2026-10-29 | Phase 3 docs MVP | Files added under `docs/` and `docs/ai-team/` | pass (docs-only; no app runtime tests) |
