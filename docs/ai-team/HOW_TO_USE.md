# How to use the AI team (non-expert)

You only pay **ChatGPT Go**. The automated team is therefore:

**You → Cursor Cloud Agent → GitHub PR → You merge / deploy**

## Everyday workflow

1. In Cursor, start a Cloud Agent (or chat) and say what you want done.
2. The agent should follow `docs/ai-team/TASK_PROTOCOL.md` and `docs/ai-team/AGENTS.md`.
3. It opens a **pull request** — review the diff.
4. You click **merge** on GitHub when happy.
5. You deploy (Netlify / Firebase) yourself when needed — agents must not deploy alone.

## Optional: ChatGPT Go

Use ChatGPT Go for brainstorming. If you like an idea, paste it into the Cursor task or a GitHub Issue so it becomes project memory. ChatGPT cannot talk to Cursor by itself on your plan.

## Optional: free Claude / Gemini apps

Same rule — human paste only. Not part of the automated loop.

## What “success” looks like

- Less copy/paste between apps
- One place for truth: this GitHub repo’s `docs/` + PRs
- You still approve merges and production deploys
