# BA/PO/PM Daily Command Center

A Next.js app that turns Jira project data into deterministic delivery intelligence — priorities, risks, decisions, attention queue, personal focus — and, as of V2.2, into stakeholder-ready artifacts (status updates, decision briefs, meeting summaries) you can edit and copy without leaving the app.

**Current version:** V2.2.1
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

A malformed value for any optional variable is ignored (never throws) and falls back to the safe default above.

### Claude / Anthropic (optional — enables real AI wording instead of Mock)

| Variable | Behavior when missing |
| --- | --- |
| `ANTHROPIC_API_KEY` | Every AI-labeled output (risk explanations, communication drafts, artifact wording, weekly review narrative, etc.) runs through the deterministic **Mock AI** provider instead — same schemas, same trust labeling, clearly marked "Mock fallback" everywhere it appears. No external call is made, no data leaves the browser. |

Read server-only inside `src/app/api/command-center/ai/route.ts`; the browser only ever POSTs an already-built prompt string and receives back schema-validated JSON — it never talks to Anthropic directly and never sees the key.

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

# V2.2.1 — Production Completion & Deployment Readiness

See the assistant's final report for this pass (baseline, fixes made, production readiness gate, and the full Post-V2.2.1 backlog) in the project conversation history. Summary: no new product capabilities were added — this was a completion/stabilization pass fixing trust-label inconsistencies, a duplicate-memory-event bug, a static-rendering bug on two Jira API routes, and adding request timeouts to every outbound Jira/Claude call.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
