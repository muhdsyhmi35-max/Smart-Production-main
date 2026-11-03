# Project brief — Smart Production Monitoring

## Objective

TF2 production dashboard with realtime operator views, monitor mode, Google Sheet scan logging, Firebase Realtime DB sync, and a Firebase Cloud Functions scheduled clock update.

## Primary users

- Operators on the floor / production line
- Supervisors monitoring status

## Success looks like

- Dashboard loads and shows live state when Firebase is configured
- Scan logging and command sync behave as documented in `DEPLOY.md`
- Changes ship via GitHub PRs; production deploy stays human-approved

## Out of scope (unless added to REQUIREMENTS)

- Fully unsupervised production deploys by AI agents
- Paid multi-model API orchestration (see `docs/ai-team/BUDGET_DECISION.md`)
