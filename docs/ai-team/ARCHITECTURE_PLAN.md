# Autonomous Multi-AI Development Team — Architecture Plan

**Status:** Phase 3 MVP scaffolding in progress (Cursor + GitHub only).  
**Repo inspected:** `muhdsyhmi35-max/Smart-Production-main`  
**Plan date:** 2026-10-29 (Asia/Kuala_Lumpur)  
**Author of this plan:** Cursor Cloud Agent (this run)  
**Budget lock:** User pays **ChatGPT Go only**; Claude/Gemini free apps. See `BUDGET_DECISION.md`. **No paid model API orchestration.**

---

## Direct answer first

**Is wiring ChatGPT + Claude + Gemini consumer apps into one team the best way?**  
**No.** That path forces copy/paste or brittle browser automation, because those products do **not** expose a supported peer-to-peer collaboration API through normal subscriptions.

**Can we make the outcome happen anyway?**  
**Yes — with a different architecture.** Use:

1. **GitHub** as the shared source of truth (code, docs, issues, PRs).
2. **Cursor Cloud Agents** as the coding, testing, and PR implementation layer (already verified in this environment).
3. **For your budget:** skip paid model APIs. Cursor runs sequential role passes (plan → research → design → implement → review → fix → report) and writes results into GitHub.
4. **You** as the approval gate for merges and production deploys. ChatGPT Go stays optional for your own brainstorming (paste into Issues if it should persist).

That delivers the collaboration loop without manual ferrying between four AI apps, at **~$0 extra API cost**.

---

## Verified vs assumed

### Verified in this environment

| Item | Status |
|------|--------|
| GitHub repo connected | Yes — `github.com/muhdsyhmi35-max/Smart-Production-main` |
| Cursor Cloud Agent can edit code, commit, push, open PRs | Yes — this run |
| Network egress available for the agent | Yes (unrestricted in this run) |
| Existing multi-agent orchestration in repo | No |
| Project memory docs (`PROJECT_BRIEF.md`, `AGENTS.md`, etc.) | Not present yet |
| ChatGPT / Claude / Gemini accounts linked here | **Not verified** — do not claim connected |
| OpenAI / Anthropic / Google API keys present | **Not verified** |
| Cursor subscription tier / API quotas | **Not verified** from this agent |
| Firebase / Netlify credentials for deploy | Present in project docs as config guidance; production secrets **not verified** in this agent |

### Assumptions / defaults after budget reply

- **Resolved:** No paid OpenAI / Anthropic / Gemini API keys for orchestration.
- You accept GitHub Issues + PR comments + `docs/` as the agent communication bus.
- Production deploy stays human-approved (default: yes).
- Remaining defaults listed in `OPEN_QUESTIONS.md`.

---

## 1. Recommended architecture

### Name: **GitHub-centric Role Router (GCRR)**

```
You ──▶ GitHub Issue / Cursor task
            │
            ▼
     Orchestrator (GitHub Action or small Node runner)
            │
            ├─▶ Planner model (OpenAI API)     → writes PLAN.md / issue checklist
            ├─▶ Researcher model (Gemini API)  → writes RESEARCH.md (optional)
            ├─▶ Architect/Reviewer (Anthropic) → writes REVIEW.md / PR review
            │
            ▼
     Cursor Cloud Agent (implement + test + PR)
            │
            ▼
     Reviewer model or Cursor Bugbot/PR review
            │
            ▼
     Correction loop (bounded) → Cursor again
            │
            ▼
     Completion report on the Issue + PR
            │
            ▼
     Human approval → merge / deploy
```

### Design principles

- **Docs + GitHub > chat history** for memory.
- **One coding agent** (Cursor) owns file edits — avoids agents overwriting each other.
- **Role models via API**, not consumer chat apps.
- **Branches + PRs** for isolation.
- **Approval gates** before merge and before deploy.
- **Modular:** start with Cursor-only; add API roles when keys exist.

### Why not “MCP alone”

MCP connects tools to one agent. It does **not** by itself schedule ChatGPT ↔ Claude ↔ Gemini as independent teammates. Treat MCP as an optional connector inside Cursor (GitHub, docs, browsers), not as the orchestration fabric.

---

## 2. Role and responsibilities

| Role | Intended “brand” | Actual runtime | Responsibilities | May update |
|------|------------------|----------------|------------------|------------|
| Coordinator / PM | ChatGPT | OpenAI API *or* Cursor agent in plan mode | Parse objective, break into subtasks, assign, resolve conflicts, write completion report | `TASKS.md`, issue checklist, `CHANGELOG.md` (summary) |
| Architect / Independent reviewer | Claude | Anthropic API *or* separate Cursor/review pass | Architecture critique, post-impl review with severities + file refs | `SYSTEM_ARCHITECTURE.md` (proposals), `KNOWN_ISSUES.md`, PR review comments |
| Researcher / Analyst | Gemini | Google AI API *or* Cursor with web tools | Options research, tradeoffs, citations into docs | `RESEARCH/` notes only; never silent requirement invention |
| Implementer | Cursor | Cursor Cloud Agent | Inspect code, targeted edits, tests, report files/risks | Source code, tests, `TESTING.md` results section |
| Source of truth | GitHub | GitHub | Code, docs, issues, PRs, Actions logs | All durable artifacts via PR |

**Rule:** No agent invents requirements. New requirements go into `REQUIREMENTS.md` via PR and need your approval (or an explicit “auto-accept non-breaking clarifications” policy you set).

---

## 3. Communication diagram (information flow)

```
┌─────────────┐     task text      ┌──────────────────┐
│    You      │ ─────────────────▶ │  GitHub Issue    │
└─────────────┘                    │  + labels        │
                                   └────────┬─────────┘
                                            │ webhook / manual dispatch
                                            ▼
                                   ┌──────────────────┐
                                   │  Orchestrator    │
                                   │  (Actions/Node)  │
                                   └────────┬─────────┘
            ┌───────────────────────────────┼───────────────────────────────┐
            ▼                               ▼                               ▼
   ┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
   │ Planner (API)   │            │ Researcher(API) │            │ Architect(API)  │
   │ → PLAN artifact │            │ → RESEARCH.md   │            │ → design check  │
   └────────┬────────┘            └────────┬────────┘            └────────┬────────┘
            └───────────────────────────────┼───────────────────────────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │ Approved PLAN    │◀── human checkpoint
                                   └────────┬─────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │ Cursor Agent     │
                                   │ branch + code    │
                                   │ + tests + PR     │
                                   └────────┬─────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │ Reviewer (API)   │
                                   │ findings on PR   │
                                   └────────┬─────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │ Fix loop ≤ N     │
                                   └────────┬─────────┘
                                            ▼
                                   ┌──────────────────┐
                                   │ Completion report│
                                   │ on Issue         │
                                   └────────┬─────────┘
                                            ▼
                                         You merge
```

Agents exchange information by **writing/reading GitHub artifacts** (issue comments, PR comments, markdown in `docs/`), not by DMing each other.

---

## 4. Comparison of practical orchestration options

| Option | How it works | Pros | Cons | Fit |
|--------|--------------|------|------|-----|
| **A. Cursor-only + GitHub docs** (MVP) | One instruction to Cursor Cloud; structured docs; PR + optional second review pass | Works today; lowest cost/complexity; already verified | Single-vendor coding loop; “multi-AI brands” are simulated by prompts/roles | **Best starting point** |
| **B. GitHub Actions + multi-model APIs** | Issue label triggers workflow calling OpenAI/Anthropic/Google, then launches/notifies Cursor | True multi-model; auditable logs; no copy/paste | Needs API keys + Actions setup; more moving parts | **Best mid-term** |
| **C. Custom orchestrator framework** (LangGraph, CrewAI, AutoGen, etc.) | Self-hosted graph of agents | Flexible | Ops burden; easy to overbuild; still needs Cursor/GitHub for real code | Only if B is insufficient |
| **D. Consumer ChatGPT/Claude/Gemini apps + glue** | Zapier/browser/copy | Familiar UIs | Fragile; ToS/API gaps; manual risk remains | **Not recommended** |
| **E. MCP-only mesh** | MCP servers between tools | Good for tool access | Not a multi-agent scheduler by itself | Support layer only |

**Recommendation (locked by budget):** Ship **A** only. Do not build **B** until the user chooses to pay for API usage. Skip **D**.

---

## 5. Required accounts, apps, APIs, integrations

### Minimum (Phase 3 MVP — Cursor + GitHub)

| Need | Purpose | Verified? |
|------|---------|-----------|
| GitHub account + this repo | SoT, Issues, PRs | Yes |
| Cursor (Cloud Agents) | Implementation | Yes (this run) |
| Structured docs under `docs/` | Shared memory | To be created |

### Recommended (Phase 4–5 multi-model)

| Need | Purpose | Verified? |
|------|---------|-----------|
| OpenAI API key | Planner / coordinator | No |
| Anthropic API key | Architect / reviewer | No |
| Google AI Studio / Gemini API key | Research | No |
| GitHub Actions enabled | Orchestration triggers | Assumed available on GitHub.com |
| GitHub Secrets for API keys | Secure storage | Not configured yet |

### Optional later

| Need | Purpose |
|------|---------|
| Cursor Automations / Bugbot | Scheduled or PR-triggered review |
| Slack | Human notifications (approval requests) |
| Netlify + Firebase deploy tokens | Deploy after approval only |

---

## 6. What existing subscriptions can vs cannot do

### Likely possible with Cursor + GitHub alone (no extra AI APIs)

- One instruction → plan → implement → test → PR → completion notes
- Shared project memory via markdown in repo
- Branch isolation, PR review, bounded fix loops inside one agent run
- Human approval before merge/deploy

### Requires additional API access (not consumer chat subscriptions)

- Independent Claude-quality review **as a separate model call** after Cursor implements
- Gemini-specific research calls in automation
- ChatGPT-as-PM as an automated step without you opening chat.openai.com

### Not available / not reliable

- Direct ChatGPT ↔ Claude ↔ Gemini consumer app messaging
- Claiming those four apps are “connected” without verified API keys and workflows
- Fully unsupervised production deploys (should stay gated)

---

## 7. Realistic cost assessment (order-of-magnitude)

Costs vary by model and task size. Treat these as planning ranges, not quotes.

| Component | Typical monthly range (light personal use) | Notes |
|-----------|--------------------------------------------|-------|
| Cursor subscription | Whatever you already pay | Cloud agent usage may have plan limits — **verify in Cursor billing** |
| GitHub | Free for public/private personal use common | Actions minutes usually enough for light orchestration |
| OpenAI API | ~$5–40 | Planner prompts are small; spikes if dumping whole repos |
| Anthropic API | ~$10–60 | Reviews on diffs are moderate; full-repo dumps cost more |
| Gemini API | Often low / free tier for light research | Check current Google AI Studio pricing |
| Custom VPS for orchestrator | $0 if Actions-only; ~$5–20 if always-on server | Prefer Actions to avoid VPS |

**Cost control rules**

- Pass **diffs and relevant files**, never whole monorepos, into reviewer/researcher calls.
- Cache research; don’t re-research identical questions.
- Cap correction loops (e.g. N=2 or 3).
- Prefer Cursor-only until API spend is justified.

---

## 8. Phased setup guide (non-expert)

### Phase 1 — Discovery (this document)

Done for this repo: GitHub + Cursor confirmed; consumer AI bridges not present.

### Phase 2 — Architecture (this document)

Adopt GCRR; roles mapped to APIs/Cursor; memory docs defined below.

### Phase 3 — Minimum Viable System (in this PR)

1. Add `docs/` memory files — done.
2. Add `AGENTS.md` + `TASK_PROTOCOL.md` + completion template — done.
3. Budget locked to Cursor + GitHub — done (`BUDGET_DECISION.md`).
4. Next after merge: run one tiny validation task and fill a completion report (`T-002`).

### Phase 4 — Coding integration

1. Standardize: Cursor always works on `cursor/...` branches and opens PRs.
2. Require tests/validation commands in `TESTING.md`.
3. No direct pushes to `main` by agents.

### Phase 5 — Autonomous review loop

1. After PR opened: reviewer pass (Anthropic API **or** second Cursor review prompt).
2. Findings → issue comments → Cursor fix ≤ N times.
3. Stop conditions encoded in `AGENTS.md`.

### Phase 6 — Validation

Run one end-to-end demo task; keep artifacts in the Issue.

### Phase 7 — Expansion

Only then add Gemini research automation, Slack alerts, deploy hooks.

---

## 9. Shared project memory (proposed)

| Document | Purpose | Who updates | Conflict rule |
|----------|---------|-------------|----------------|
| `docs/PROJECT_BRIEF.md` | Objectives | Human (+ coordinator draft via PR) | Human wins |
| `docs/REQUIREMENTS.md` | Approved requirements | Human approval required | No silent edits to “Approved” section |
| `docs/SYSTEM_ARCHITECTURE.md` | Architecture | Architect proposes; human/coordinator merges | PR review required |
| `docs/DECISIONS.md` | ADRs | Architect/coordinator | Append-only; supersede via new ADR |
| `docs/TASKS.md` | Current tasks | Coordinator | Status changes only via Issue sync |
| `docs/KNOWN_ISSUES.md` | Bugs | Reviewer/implementer | Link to GitHub Issues |
| `docs/TESTING.md` | How to test + last results | Implementer | Results must cite commands/output |
| `docs/CHANGELOG.md` | History | Coordinator after merge | Append-only |
| `docs/AGENTS.md` | Agent rules & permissions | Human | Human-only |

---

## 10. Safety and control (defaults)

- No production deploy without your approval.
- No destructive git/firebase/netlify actions without approval.
- Secrets only in GitHub Secrets / Cursor secrets — never in docs or commits.
- Agents use feature branches; one implementer role owns code edits.
- Correction loop default: **max 3**.
- Never invent test results; if tests weren’t run, say so.
- Escalation to you when agents disagree on a safe approach.

---

## 11. Questions

See `OPEN_QUESTIONS.md`. Budget items **resolved**. Defaults applied for the rest.

---

## 12. Next action

Phase 3 scaffolding is in this branch. After you merge:

1. Give Cursor any small task using `TASK_PROTOCOL.md`.
2. Merge the resulting PR.
3. Deploy yourself only when needed.

Do **not** buy API keys unless you later want true multi-vendor automated review.

---

## Appendix: Mapping your requested capabilities

| Capability | MVP (A) | Full (B) |
|------------|---------|----------|
| Shared project context | Markdown + GitHub | Same |
| Intelligent task assignment | Cursor coordinator prompt | Orchestrator + planner API |
| Agent collaboration without copy/paste | Issue/PR artifacts | Same + Actions |
| Autonomous implementation | Cursor Cloud Agent | Same |
| Independent code review | Second Cursor pass / Bugbot | Anthropic API on diff |
| Automated correction loop | Bounded in agent + PR | Actions-driven re-runs |
| Completion report | Issue comment + PR body | Same, templated |
