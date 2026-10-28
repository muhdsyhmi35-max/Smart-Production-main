# System architecture

## High level

```
Browser (index.html / script.js / style.css)
    │
    ├─▶ Firebase Realtime Database (live state / commands)
    ├─▶ Google Sheets (scan logging) — via configured client flows
    │
Netlify ── hosts static frontend

Firebase Cloud Functions ── scheduled clock worker
```

## Repo layout (root)

| Path | Role |
|------|------|
| `index.html`, `style.css`, `script.js` | Operator / monitor UI |
| `netlify.toml` | Static hosting |
| `firebase.json`, `functions/` | Cloud Functions backend |
| `DEPLOY.md` | Deploy steps |
| `docs/` | Project memory + AI team protocol |
| `Smart-Production-main/` | Nested copy — treat carefully; prefer root files unless task says otherwise |

## AI team layer (MVP)

Cursor Cloud Agent reads `docs/`, implements on feature branches, opens PRs.  
No external model API orchestrator in this phase.
