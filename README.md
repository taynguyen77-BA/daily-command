# BA/PO/PM Daily Command Center

A Next.js app that turns Jira project data into deterministic delivery intelligence — priorities, risks, decisions, attention queue, personal focus — and, as of V2.2, into stakeholder-ready artifacts (status updates, decision briefs, meeting summaries) you can edit and copy without leaving the app.

**Current version:** V2.45
**Status:** READY WITH LIMITATIONS — see the [V2.2.1 report](docs/RELEASE-NOTES.md#v221--production-completion--deployment-readiness) below for the full breakdown. The two limitations are both environment facts (no Jira credentials, no Anthropic API key configured in this environment), not implementation gaps.

**Version line:** this line drifted stale four times (V2.2.1, V2.9, V2.15, V2.25 — see docs/RELEASE-NOTES.md), so it is now enforced: `package.json` `"version"` is the source of truth (`2.45.0` ↔ `V2.45`) and the test suite fails if this line disagrees with it, or if any `(V2.NN)` heading is newer than it (group `E6 Version line`).

Core principle: every important claim is either **CALCULATED** (deterministic, from your data), **EVIDENCE** (a specific underlying fact), **AI DRAFT** (Claude/Mock wording you review before use), **USER INPUT** (something you or your import provided), or explicitly **UNKNOWN** — never guessed, never silently blended.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without any environment variables set, the app works fully in **Demo** mode (fictional seed data) and **Mock AI** mode (deterministic template output, no external calls) — nothing below is required to try it.

```bash
npm test          # deterministic-engine test suite (scripts/tests/run.mts → scripts/tests/*.test.mts)
npx tsc --noEmit   # typecheck
npm run build      # production build
```

## Environment Variables

None are required to run the app. Configure only the ones you actually need.

### Where things are documented

| What | Where |
|---|---|
| Every environment variable (Jira, Claude, Slack, server-side notify, cross-device sync, Vercel) | [docs/CONFIG.md](docs/CONFIG.md) |
| Release history (`V2.x` sections, page smoke test, validation status, V2.2.1 summary) | [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md) |
| Audit task state | [docs/TASK-STATE.md](docs/TASK-STATE.md) → `AUDIT_TASK_STATE.md` |
| Prompt packs used to build the app | [docs/prompts/](docs/prompts/) |
| Working rules for contributors and Claude Code | `CLAUDE.md` |

The most common variables (all optional; the app runs in Demo + Mock AI without any):

| Variable | Purpose |
|---|---|
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Live Jira sync (read-only by default) |
| `JIRA_TIMEZONE` / `JIRA_TIMEZONE_OFFSET_MINUTES` | Your Jira timezone for date cursors (IANA zone preferred; learned from Jira when unset) |
| `ANTHROPIC_API_KEY` | Real AI wording instead of Mock AI |
| `SLACK_WEBHOOK_URL`, `PERSONAL_JIRA_ACCOUNT_ID` | Mention / assignment notifications; the account the server-side check watches |
| `CRON_SECRET`, `APP_STATE_SECRET` | Authorise the scheduler and pair a device (also needed to read the full status endpoints) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Server-side state (notify baseline, sync, snapshots) |
| `AUTH_ENABLED` | Team sign-in (off by default) |

### Feature index

Each item below is a section of [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md) (newest first): Delivery guarantees & timezone cursors (V2.44.1) · Consistency, exposure and trustworthy tests (V2.45) · Smarter guidance (V2.44) · Smarter ranking (V2.43) · Reliability (V2.42) · Notify correctness (V2.41) · Guard rails (V2.40.1) · Team sign-in (V2.40) · Review fixes (V2.39, V2.35) · Task-level AI (V2.36–V2.37) and BA/PM AI features (V2.38) · Daily flow (V2.34) · Final-review fixes (V2.33) · Daily helpers (V2.30) · Task status model (V2.31) · Page smoke test · Validation status.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
