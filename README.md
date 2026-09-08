# BA/PO/PM Daily Command Center

A Next.js app that turns Jira project data into deterministic delivery intelligence — priorities, risks, decisions, attention queue, personal focus — and, as of V2.2, into stakeholder-ready artifacts (status updates, decision briefs, meeting summaries) you can edit and copy without leaving the app.

**Current version:** V2.15
**Status:** READY WITH LIMITATIONS — see the [V2.2.1 report](#v221-production-completion--deployment-readiness) below for the full breakdown. The two limitations are both environment facts (no Jira credentials, no Anthropic API key configured in this environment), not implementation gaps.

**Version-line reconciliation (again):** this line had drifted stale at V2.10 even though several real passes (V2.10.1's cold-start fix, V2.11's global Work Relevance Policy, V2.12's signal-splitting fixes, and an earlier same-day V2.13 pass covering My Day's Work Relevance gate/hidden sections/ticket links) had already shipped without ever updating it here — the same class of gap this README already flagged and fixed once before (see the V2.10 section below). Corrected to V2.13 as part of this pass, which itself adds the separate "Server-Side Real-Time Notify" capability described below.

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
| `CRON_SECRET` (V2.10, fixed V2.15) | Requires `Authorization: Bearer <value>` on every request to `/api/command-center/jira/sync`, for the scheduled sync in `vercel.json` / `.github/workflows/sync.yml`. | The sync route stays exactly as open as it always was — no auth check. **V2.15 fix:** configuring `CRON_SECRET` alone used to disable the in-app "Sync Now" button (a browser can never safely hold `CRON_SECRET`). The route now also accepts `Authorization: Bearer <APP_STATE_SECRET>` (see Cross-Device Sync below) — pair this device once in Data & Settings and Sync Now works again even with `CRON_SECRET` locked down. Without pairing, the button now fails with a specific "pair this device" message instead of a bare 401. |

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
| `SLACK_CHANNEL_LABEL` (V2.11, optional, display-only) | A free-text label you choose (e.g. `#daily-command-alerts` or `DM to Tay`) purely so Data & Settings can answer "where do my alerts go?" without server access — it has zero effect on where the webhook actually sends (that's entirely `SLACK_WEBHOOK_URL`, set on the Slack side). Shown as "Not labeled" when missing. |

Read server-only inside `src/app/api/command-center/notify/route.ts`; the browser only ever POSTs already-built, non-secret signal payloads (issue key, summary, Jira link, mention/assignment detail) and never sees the webhook URL. Requires a `PersonalIdentity.accountId` configured in Data & Settings (see the Jira account ID field) — without one, mention/assignment tracking has nothing to match against and no notification is ever produced, regardless of whether this variable is set. Data & Settings' "Slack Notifications" panel shows whether `SLACK_WEBHOOK_URL` is configured (boolean only, never the URL), the `SLACK_CHANNEL_LABEL` value, and a "Send test notification" button that exercises the exact same webhook-call path as a real signal — a failed test now also shows Slack's real HTTP status/response (or the network error), so a revoked or mistyped webhook is actually debuggable from the UI rather than a bare "delivery failed" (V2.13 bug fix).

**Notifications now fire from an unattended cron run too**, once `PERSONAL_JIRA_ACCOUNT_ID` + Vercel KV are configured (V2.13, see below) — without those, notify remains browser-tab-dependent exactly as in V2.10: a real signal is only ever sent while a browser tab has the app open and recomputes.

### Server-Side Real-Time Notify (V2.13, optional)

Everything above (V2.10's Slack notifications) only ever fires from a **browser tab** that has the app open — `use-command-center.ts`'s notify effect runs client-side, on every recompute, and there is no server-side persistence for it to run from unattended. This section adds exactly one narrow, explicit exception to that: a small server-side key-value store holding two things for the configured personal Jira account — the set of issue keys currently assigned to it, and the set of comment IDs already known to mention it — so a cron-triggered sync can detect a genuinely NEW assignment/mention and Slack it even when no browser is open.

**This is the only server-side state in the entire app.** Every other capability — work items, risks, decisions, snapshot history, the Work Relevance Policy, everything — remains exactly as local-only as `types.ts`'s own "Local-only V1: no auth, no multi-tenant, no backend" statement always said. This was a deliberate, explicit, narrow decision, not a general move toward a backend.

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `PERSONAL_JIRA_ACCOUNT_ID` | Server-only, separate from the browser-stored `PersonalIdentity.accountId` (a cron invocation has no browser session to read that from) — the Jira `accountId` the server-side check tracks assignments/mentions for. | The cron sync runs exactly as it did before this pass (fetches and returns fresh Jira data, but nothing durable consumes it) — a complete no-op for this capability. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected by Vercel once a KV store is created and linked to the project (Storage tab → Create Database → KV → Connect to Project). Required by `@vercel/kv`. | Same as above — a complete no-op; `notify-store.ts`'s `get()` returns `null` and `set()` does nothing, never an error. |

Both are required together for the server-side path to activate; either one missing means an install behaves byte-for-byte like it did before this pass (Option A/client-only). Data & Settings' "Slack Notifications" panel and `GET /api/command-center/notify` both report the live `serverSideNotifyActive` boolean so you can confirm which mode is actually active.

**Honesty about what this does and doesn't do:** this makes real-time notify genuinely real-time-and-unattended **once configured** — it does not make the app "always real-time regardless of setup." An install that never sets up `PERSONAL_JIRA_ACCOUNT_ID` + Vercel KV behaves exactly as it did in V2.10/V2.12: notifications only fire while a browser tab is open. Once both server-side and client-side notify are active, the client detects this (`serverSideNotifyActive: true`) and defers entirely to the server path — it still computes everything for its own UI (lifecycle badges, etc.), it just skips its own Slack POST, so a mention/assignment is never double-sent by two independent tracking systems (server KV vs. browser localStorage).

The very first cron run after this is configured for an install that already has real assigned/mentioned tickets sitting in Jira establishes a baseline and sends **zero** Slack messages — the exact same cold-start discipline V2.10.1 already guarantees for the browser-tab path, now also true for the unattended one. A cron run's own connectivity failure (Jira unreachable, credentials rejected, etc.) never corrupts the persisted baseline — the next successful run still diffs correctly against the last known-good state.

**A note on `@vercel/kv`:** as of this pass, npm reports `@vercel/kv` as deprecated in favor of installing a Redis integration (Upstash) directly from the Vercel Marketplace — Vercel's own KV product is being wound down, though existing KV stores and this package's `KV_REST_API_URL`/`KV_REST_API_TOKEN` contract still work today (the package is a thin wrapper over `@upstash/redis` reading those same two variables). This pass follows the dev prompt's explicit instruction to use `@vercel/kv` and those exact dashboard steps; if Vercel fully sunsets the old dashboard flow before you set this up, installing `@upstash/redis` directly against the same two env var names is a same-shape, one-file (`src/lib/server/notify-store.ts`) swap — the `NotifyStateStore` interface this pass introduced was written specifically so that swap never needs to touch `cron-notify.ts` or any caller.

### Cross-Device Sync (V2.15, optional)

Depends on V2.13 (Server-Side Real-Time Notify) already having Vercel KV set up — this reuses the same KV store/credentials and adds a second, still narrow, blob of server-side state.

**Only the state that actually diverges across devices syncs — not everything.** Work items, risks, drift, dependencies, priorities, and `snapshotHistory` are all recomputed fresh from Jira on every sync, on every device independently — since Jira is the real source of truth, that data is already substantively consistent across devices without any extra plumbing. What genuinely needs to sync (and didn't before this pass) is:

1. `personalIdentity` (accountId, displayName, email)
2. `jiraWorkRelevancePolicy` (the global policy map, V2.11)
3. `attentionState` (per-item lifecycle: NEW/ACTIVE/ACKNOWLEDGED/RESOLVED/RE_ESCALATED — the single biggest source of "acknowledged on desktop, still shows as new on phone")
4. `decisions` (Decision Log entries)
5. Action Plan / Close Day interaction state (`data.actions` status/notes/outcomes, and the Focus Session/My Day `personalPlan`)
6. `memoryEvents`
7. UI preferences added V2.11-V2.14 (advanced-sections toggle, "My action items only" per page, Focus Project Scope selection)

Everything else stays local, per device, un-synced by design — e.g. `snapshotHistory` trend charts can legitimately show slightly different data per device (each device's own recent Jira syncs), while decisions and acknowledgments are identical everywhere once synced.

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `APP_STATE_SECRET` | Required by both `GET`/`POST /api/command-center/state`. Unlike `CRON_SECRET` above, this data is genuinely private (decision content, identity, interaction history) — an **unconfigured** `APP_STATE_SECRET` means sync is treated as unavailable (503), never silently open. Generate with `openssl rand -hex 32`, same as `CRON_SECRET`, and set it identically to a server-side Vercel env var. | The Cross-Device Sync layer is completely inert — the app behaves exactly as it does today, local-only, no errors. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Same Vercel KV store V2.13 already uses. | Same — a complete no-op; `app-state-store.ts`'s `get()` returns `null` and `set()` does nothing. |

**Never put `APP_STATE_SECRET` in a `NEXT_PUBLIC_*` env var** — that would bundle it into every visitor's JS at build time. Instead, each browser is "paired" individually: open **Data & Settings → Cross-Device Sync**, paste the secret once, and it's stored only in that device's own `localStorage` (`device-pairing.ts`) — the same one-time-per-device setup as a password manager or 2FA app. The paired secret is also what a browser's own "Sync Now" button sends to `/api/command-center/jira/sync` (see the `CRON_SECRET` fix above) — it is never a third secret, just reused.

**Client sync lifecycle:** on load, the app renders immediately from local state (unchanged, no blank-screen wait); in the background, a paired device pulls the server's copy and reconciles it against local state:
- Server has no state yet → this device's local state becomes the baseline (protects an existing pre-V2.15 install's real local data — see the dedicated migration-safety test in `scripts/command-center-test.mts`).
- Local looks never-meaningfully-used (no attention lifecycle activity, no decisions, no planning activity) → adopt the server's copy wholesale.
- Both sides have real content and the server is newer → merge: record collections (decisions, actions, personal-plan items, memory events) union by id so a locally-added-but-not-yet-synced record is never dropped, even though the single-timestamp blob design (§ below) means simple preference blocks resolve to "whichever whole side is newer," not true per-field freshness.
- Otherwise (this device is already at least as fresh as the server knows) → push local forward.

Every mutation to a synced field debounces a single `POST` a few seconds later (rapid edits coalesce into one KV write); a failed `POST` (offline) is retried with exponential backoff and retried immediately on the browser's `online` event — the pending write is never lost in the meantime, since it's already sitting in the same `localStorage`-persisted local state every other mutation already uses.

**Honesty about the merge model:** the server blob carries exactly one `updatedAtIso`, not one per field — so "per-field where reasonable" (Task 3's own escape hatch) means id-level union for record collections, and "whichever whole side is newer" for scalar preference blocks (UI toggles, identity). True concurrent field-level editing is rare for a single-user tool; this is the documented, honest boundary of that design rather than a fabricated finer-grained merge.

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

# V2.13 — Server-Side Real-Time Notify (Option B) + Five Bug Fixes

Two independent pieces of work, both in this pass.

**Server-Side Real-Time Notify:** see the [Server-Side Real-Time Notify](#server-side-real-time-notify-v213-optional) section above for the full picture. In short: a small, single-key server-side store (`src/lib/server/notify-store.ts`, `@vercel/kv`-backed) tracks a personal Jira account's assigned-issue-keys and already-notified comment IDs, so `src/lib/command-center/cron-notify.ts`'s `runServerSideNotifyCheck` (wired into `jira/sync/route.ts`'s GET handler, the one Vercel Cron/GitHub Actions actually calls) can detect a genuinely new assignment/mention and Slack it with no browser open — reusing V2.10's own `detectNewAssignments`/`buildMentionEvents` rather than a second implementation. The client (`use-command-center.ts`) checks a new `serverSideNotifyActive` status flag and defers entirely to the server path once it's active, preventing the two independent tracking systems (server KV vs. browser localStorage) from double-sending the same signal. `cron-notify.ts` itself is deliberately NOT `import "server-only"` (unlike the dev prompt's literal instruction) and takes an injected `fetchImpl`/`NotifyStateStore`, so the cold-start, double-notification-prevention, and connectivity-failure-never-corrupts-state guarantees are all covered by real, offline, dependency-injected tests (`scripts/command-center-test.mts`) rather than a manual trace — the credential/env-var-touching pieces (`notify-store.ts`'s real KV client, the sync route's wiring) stay server-only and are verified the same way the existing `jira-client.ts`/`jira/sync/route.ts` split already is (source-text assertions, never imported into the test process).

**Five bug fixes**, reported directly by the user:
1. **Jira Work Relevance Policy "resets on deploy"** — investigated thoroughly; the policy is persisted in browser `localStorage` (`command-center:v1`, unchanged since it was introduced) with fully defensive parsing/migration, and no code path in this app ever clears or version-gates it. No code bug was found. The overwhelmingly likely real cause is environmental: Vercel gives every deployment (including Production ones without a stable custom domain) its own unique `*.vercel.app` URL in addition to the stable aliased production URL — visiting a fresh per-deployment URL after each deploy is a different browser origin, hence empty `localStorage`, which looks exactly like "reset on deploy" without actually being one. If you're seeing this, check which URL you're opening after each deploy; visiting the same stable Production URL every time should persist the policy correctly.
2. **Attention Queue showing tickets that need no action** — confirmed and fixed: the Attention Queue (`attention-queue.ts` → `proactive.ts`) never consulted the Work Relevance Policy at all, unlike My Day/Action Plan. A risk/dependency/decision/mention/assignment tied to a ticket the user has classified COMPLETED or EXCLUDED now drops out of the Attention Queue entirely, on both the dashboard panel and the full `/attention` page. Deliberately narrower than My Day's own gate: WAITING and UNKNOWN tickets stay visible (this is delivery intelligence, not "is this my personal work", and the queue must not go quiet just because a status hasn't been classified yet).
3. **Completing a task did nothing** — the clearest instance was Priorities/Take Action's "Mark as handled" button, which only ever flipped local component state (forgotten the instant the panel closed) with no persisted effect whatsoever. It now creates/completes a real `Action` record via the same `completeAction` path Action Plan's own "Complete" button uses, and the Priorities card shows a persisted "Handled" badge.
4. **No link for ticket numbers** — Priorities/Take Action already had real ticket links from an earlier same-day pass, but Your Delivery Focus (My Day) and the Attention Queue never carried a ticket key/URL on their own data models at all. `AttentionItem` and `PersonalFocusCandidate` gained `ticketKey`/`ticketUrl` fields (resolved from the same `sourceRef` → `WorkItem` logic Personal Focus already used, reused rather than duplicated), wired into `PersonalFocusCard`, `FocusSession`, and `AttentionItemCard` via the shared `TicketLink` component. Demo/Local Import data still shows plain text, never a fabricated link, matching `TicketLink`'s existing discipline.
5. **"Send test notification" not working** — tested end-to-end locally against a real local webhook receiver; the feature works correctly. The likely real-world cause is a Vercel configuration issue (an unset or unpropagated `SLACK_WEBHOOK_URL` in Production, or a revoked/mistyped webhook URL) rather than a code bug. Improved regardless: a failed test now surfaces Slack's real HTTP status/response body (or the network error) instead of a bare "delivery failed", so a misconfigured webhook is actually debuggable from the Data & Settings UI.

# V2.10 — Real-Time Mention & Assignment Tracking

See the assistant's final report for this pass in the project conversation history. Summary: identity matching now prefers a configured Jira `accountId` over display name (disambiguating two people who share one on a multi-org instance); the Attention Queue/Personal Focus gained two new, append-only categories — MENTION (a comment mentioning you) and ASSIGNMENT (a new direct assignment) — both 100% deterministic, zero AI calls; a diff-based Slack notifier fires only for genuinely new personal signals; and sync can now run on a schedule (Vercel Cron or a GitHub Actions fallback), gated by an optional `CRON_SECRET`. The six pre-existing Attention Queue/Personal Focus categories are untouched — same order, same output, same tests.

**Version-line reconciliation:** this README's "Current version" line had drifted stale at V2.2.1 even though the codebase's own doc-comments (`src/`) had already moved through V2.3–V2.9 (Focus Project Scope, Work Relevance Policy, Execution Path & Work Signal Calibration, and more) without ever being reflected here. That gap was closed as part of this pass — the line was corrected to V2.9 (the real pre-V2.10 state) before V2.10's own changes were layered on top, which is why it reads V2.2.1 → V2.10 above rather than skipping a step silently.

**Post-deploy fix:** `vercel.json`'s cron was originally `*/15 * * * *`, which Vercel Hobby plans reject outright at deploy time ("Hobby accounts are limited to daily cron jobs") — every deploy since V2.10 landed had been silently failing because of this, leaving production stuck on the pre-V2.10 build despite successful pushes. Fixed to a Hobby-safe daily schedule (`0 6 * * *`); the GitHub Actions workflow still covers the tighter 15-minute cadence.

# V2.2.1 — Production Completion & Deployment Readiness

See the assistant's final report for this pass (baseline, fixes made, production readiness gate, and the full Post-V2.2.1 backlog) in the project conversation history. Summary: no new product capabilities were added — this was a completion/stabilization pass fixing trust-label inconsistencies, a duplicate-memory-event bug, a static-rendering bug on two Jira API routes, and adding request timeouts to every outbound Jira/Claude call.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Vercel deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
