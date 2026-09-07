# BA/PO/PM Daily Command Center

A Next.js app that turns Jira project data into deterministic delivery intelligence — priorities, risks, decisions, attention queue, personal focus — and, as of V2.2, into stakeholder-ready artifacts (status updates, decision briefs, meeting summaries) you can edit and copy without leaving the app.

**Current version:** V2.10
**Status:** READY WITH LIMITATIONS — see the [V2.2.1 report](#v221-production-completion--deployment-readiness) below for the full breakdown. The two limitations are both environment facts (no Jira credentials, no Anthropic API key configured in this environment), not implementation gaps.

Core principle: every important claim is either **CALCULATED** (deterministic, from your data), **EVIDENCE** (a specific underlying fact), **AI DRAFT** (Claude/Mock wording you review before use), **USER INPUT** (something you or your import provided), or explicitly **UNKNOWN** — never guessed, never silently blended.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without any environment variables set, the app works fully in **Demo** mode (fictional seed data) and **Mock AI** mode (deterministic template output, no external calls) — nothing below is required to try it.

```bash
npm test          # deterministic-engine test suite (scripts/command-center-test.mts)
npx tsc --noEmit   # typecheck
npm run build      # production build
```

## Environment Variables

None are required to run the app. Configure only the ones you actually need.

### Jira (optional — enables live sync instead of Demo/Local Import)

| Variable | Required together | Behavior when missing |
| --- | --- | --- |
| `JIRA_BASE_URL` | ✓ | Jira sync/status/conformance report "not configured"; app stays in Demo/Local Import mode. |
| `JIRA_EMAIL` | ✓ | same as above |
| `JIRA_API_TOKEN` | ✓ | same as above |

All three are read **server-only** (`src/lib/server/jira-client.ts`, guarded by `import "server-only"`) and are never sent to, or readable by, the browser — confirmed by inspecting the production client bundle (only the variable *names* appear, in help text, never a value).

Optional, only meaningful once the three above are set:

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `JIRA_TIMEZONE_OFFSET_MINUTES` | Tightens the incremental-sync cursor to minute precision for your Jira instance's configured timezone (e.g. `420` for UTC+7 / Vietnam). | Falls back to a day-level cursor — still correct, just re-fetches a bit more per sync. |
| `JIRA_PROJECT_KEYS` | Comma-separated list to scope sync to specific projects (e.g. `JPMC,UBS`). | Syncs all discoverable projects. |
| `JIRA_PROJECT_CLIENT_MAP` | JSON object mapping a Jira project key to a display client name (e.g. `{"JPMC":"J.P. Morgan"}`), for "one client, many projects". | Project name is used as the client name. |
| `CRON_SECRET` (V2.10) | Requires `Authorization: Bearer <value>` on every request to `/api/command-center/jira/sync`, for the scheduled sync in `vercel.json` / `.github/workflows/sync.yml`. | The sync route stays exactly as open as it always was — no auth check. Note: setting this also disables the in-app "Sync Now" button, which cannot safely hold a server secret; see that route's own comment. |

A malformed value for any optional variable is ignored (never throws) and falls back to the safe default above.

### Claude / Anthropic (optional — enables real AI wording instead of Mock)

| Variable | Behavior when missing |
| --- | --- |
| `ANTHROPIC_API_KEY` | Every AI-labeled output (risk explanations, communication drafts, artifact wording, weekly review narrative, etc.) runs through the deterministic **Mock AI** provider instead — same schemas, same trust labeling, clearly marked "Mock fallback" everywhere it appears. No external call is made, no data leaves the browser. |

Read server-only inside `src/app/api/command-center/ai/route.ts`; the browser only ever POSTs an already-built prompt string and receives back schema-validated JSON — it never talks to Anthropic directly and never sees the key.

### Slack (optional — real-time "mentioned me" / "assigned to me" notifications, V2.10)

| Variable | Behavior when missing |
| --- | --- |
| `SLACK_WEBHOOK_URL` | No Slack notifications are ever sent; everything else (mention/assignment tracking in the Attention Queue and Personal Focus, the app itself) is unaffected. |

Read server-only inside `src/app/api/command-center/notify/route.ts`; the browser only ever POSTs already-built, non-secret signal payloads (issue key, summary, Jira link, mention/assignment detail) and never sees the webhook URL. Requires a `PersonalIdentity.accountId` configured in Data & Settings (see the Jira account ID field) — without one, mention/assignment tracking has nothing to match against and no notification is ever produced, regardless of whether this variable is set.

### Configuring in Vercel

Project Settings → Environment Variables → add the ones you need for the **Production** (and optionally **Preview**) environment, then redeploy. Never commit real values to the repo — `.env*.local` is already git-ignored.

## Validation Status

| Claim | Status |
| --- | --- |
| Verified locally (tests/typecheck/build) | ✅ Yes — see report |
| Fixture-validated (Jira conformance, mock AI) | ✅ Yes |
| Browser-verified (manual golden-path walkthrough) | ✅ Yes |
| Live Jira validated | ❌ NOT AVAILABLE — no credentials in this environment |
| Live Claude validated | ❌ NOT AVAILABLE — no `ANTHROPIC_API_KEY` in this environment |

Live Jira and Live Claude validation should be the **first thing done after deployment**, once real credentials are configured in Vercel.

---

# V2.10 — Real-Time Mention & Assignment Tracking

See the assistant's final report for this pass in the project conversation history. Summary: identity matching now prefers a configured Jira `accountId` over display name (disambiguating two people who share one on a multi-org instance); the Attention Queue/Personal Focus gained two new, append-only categories — MENTION (a comment mentioning you) and ASSIGNMENT (a new direct assignment) — both 100% deterministic, zero AI calls; a diff-based Slack notifier fires only for genuinely new personal signals; and sync can now run on a schedule (Vercel Cron or a GitHub Actions fallback), gated by an optional `CRON_SECRET`. The six pre-existing Attention Queue/Personal Focus categories are untouched — same order, same output, same tests.

**Version-line reconciliation:** this README's "Current version" line had drifted stale at V2.2.1 even though the codebase's own doc-comments (`src/`) had already moved through V2.3–V2.9 (Focus Project Scope, Work Relevance Policy, Execution Path & Work Signal Calibration, and more) without ever being reflected here. That gap was closed as part of this pass — the line was corrected to V2.9 (the real pre-V2.10 state) before V2.10's own changes were layered on top, which is why it reads V2.2.1 → V2.10 above rather than skipping a step silently.

**Post-deploy fix:** `vercel.json`'s cron was originally `*/15 * * * *`, which Vercel Hobby plans reject outright at deploy time ("Hobby accounts are limited to daily cron jobs") — every deploy since V2.10 landed had been silently failing because of this, leaving production stuck on the pre-V2.10 build despite successful pushes. Fixed to a Hobby-safe daily schedule (`0 6 * * *`); the GitHub Actions workflow still covers the tighter 15-minute cadence.

# V2.2.1 — Production Completion & Deployment Readiness

See the assistant's final report for this pass (baseline, fixes made, production readiness gate, and the full Post-V2.2.1 backlog) in the project conversation history. Summary: no new product capabilities were added — this was a completion/stabilization pass fixing trust-label inconsistencies, a duplicate-memory-event bug, a static-rendering bug on two Jira API routes, and adding request timeouts to every outbound Jira/Claude call.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
