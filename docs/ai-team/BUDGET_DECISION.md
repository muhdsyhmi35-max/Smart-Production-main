# Budget decision (locked)

**Date:** 2026-10-29 (Asia/Kuala_Lumpur)  
**Source:** User reply — “I only pay chatgpt Go. Others are free”

## What this means

| Product | Your situation | Useful for automation? |
|---------|----------------|------------------------|
| ChatGPT Go | Paid | **No** for team orchestration — app access ≠ OpenAI API key |
| Claude | Free (app) | **No** as automated teammate — free chat UI is not an API |
| Gemini | Free (app) | **No** as automated teammate unless you later add a free AI Studio API key |
| Cursor Cloud Agents | Available in this environment | **Yes** — primary implementer + coordinator |
| GitHub | Connected | **Yes** — source of truth |

## Locked architecture choice

**Option A only: Cursor + GitHub docs protocol.**

- Do **not** build OpenAI / Anthropic / Gemini API orchestration until you choose to pay for API usage.
- Optional later: Gemini **AI Studio free tier API** for light research only (still optional; not required for MVP).
- ChatGPT Go can still be used **by you** for brainstorming outside the automated loop — paste results into a GitHub Issue if you want them in project memory. Do not treat that as automated handoff.

## Expected extra AI API cost for MVP

**$0** beyond whatever Cursor / GitHub already include.
