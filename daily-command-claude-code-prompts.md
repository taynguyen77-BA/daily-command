# Daily Command — Upgrade Prompt Pack (V2.40 → V2.44)

Source reviewed: `daily-command-main.zip` @ V2.40.0. Baseline measured by the reviewer: `tsc` clean · `eslint` 0 errors / 19 warnings ·
`next build` OK (24 pages) · `npm test` 3,442 / 3,444 pass (the 2 failures are perf budgets on a slower machine) · 3 skipped (`navigator.locks`).

**Not verified by the reviewer:** anything against a live Jira / live Claude (no credentials), and the UI in a real browser.
Every finding below was confirmed by reading code and/or by a runnable repro; items that depend on Jira's live behaviour say so.

---

## 0. How to use

1. Copy `CLAUDE.md` to the repo root and the two files in `seed-tests/` to `scripts/tests/seed/` (P0.1 does this for you).
2. Run prompts **in order**, one Claude Code session per prompt (or per release group). Start each session with
   "Read CLAUDE.md, then plan before coding." Review the plan, then let it implement.
3. One prompt ≈ one PR. Merge only when its Definition of Done (CLAUDE.md) is green.
4. Release plan:

| Release | Prompts | Theme |
|---|---|---|
| V2.40.1 | P0.1 | Guard rails (CLAUDE.md, CI, perf-budget factor) |
| V2.41.0 | P1.1, P1.2 | Trust: notifications/mentions correct, UI copy truthful |
| V2.42.0 | P2.1 – P2.6 | Reliability: Jira resilience, health/heartbeat, scheduler, KV, smoke, lint |
| V2.43.0 | P3.1, P3.2, P3.3 | Smarter ranking: Score v2, ball-in-court, learning loop (shadow mode) |
| V2.44.0 | P3.4 – P3.7 | Smarter guidance: forecast, smart notifications, Next Best Action, AI readiness |

Decisions already taken so Claude Code does not stall (override in the prompt if you disagree): bootstrap window 90 days ·
Jira concurrency 5 · scoring model default `v2` with `v1` selectable · learning starts in `shadow` mode · scheduler
recommendation documented, not forced.

---

## 1. Verified findings (evidence for the prompts)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | P0 | Unattended paths put a raw ISO string into JQL (`updated >= "2026-10-27T10:15:33.123Z"`). JQL documents only `yyyy-MM-dd[ HH:mm]` in the user's timezone; the main sync route converts via `buildIncrementalSinceParam`, these do not. After the cold-start run, the steady-state run is likely rejected (400) and the failure only appears in the cron HTTP response. **Confirm live with P2.5.** | `cron-notify.ts` (`fetchMentionedIssuesWith(..., previous?.lastCheckedAtIso)`), `server-daily-report.ts` (`baseline?.lastRunIso`); test fakes ignore JQL. Seed test `35` group "JQL date format" is red. |
| F2 | P0 | Old mentions are re-announced. `notifiedCommentIds` is overwritten with only this run's ids while the JQL is `updated >= lastChecked`; any later unrelated comment on an old ticket re-announces its old mention. | Runnable repro; seed test `35` group "no re-announce" is red. |
| F3 | P0 | A transient comment-fetch failure permanently loses a mention: `collectCurrentMentions` swallows the error, yet `lastCheckedAtIso` advances, so the ticket never matches `updated >= lastChecked` again. | Code reading; seed test `35` group "transient failure" is red. |
| F4 | P1 | Comments fetched once, `maxResults=100`, no `orderBy`. Jira's default order is ascending by created (verify with P2.5), so in long threads the newest comments — where the mention is — are missed. | `jira/http.ts` `fetchIssueCommentsWith`. |
| F5 | P1 | Cron fetches every issue ever assigned (`assignee = X`, no status filter; cap 2,000 = 40 sequential pages) on every tick. | `fetchAssignedIssuesWith`. |
| F6 | P1 | No retry/backoff on Jira 429/5xx (only classified); unbounded `Promise.all` over changelog/comment fetches; no `maxDuration` on any route (AI client timeout is 55 s). | grep of `jira/http.ts`, sync route, all `route.ts`. |
| F7 | P1 | First sync is `project is not EMPTY order by updated asc` capped at 2,000 → on a large instance the OLDEST tickets arrive first, freshest last. | `buildIssuesJql`. |
| F8 | P1 | Silent failure of "real-time": Vercel cron runs once a day; the 15-min GitHub workflow exits 0 when secrets are missing; GitHub disables scheduled workflows on public repos after 60 days without repo activity; no heartbeat although `lastCheckedAtIso` is already stored. | `vercel.json`, `.github/workflows/sync.yml`, `SetupHealthBanner.tsx`. |
| F9 | P1 | Team cron always restarts from the top of the member list after a time-budget skip → members at the end can starve. | `jira/cron-tick.ts` `runCronForMembers` (comment says so). |
| F10 | P1 | No CI: only `sync.yml` exists; 3,444 checks never run automatically. Perf budgets (100/200/250 ms) fail on slower machines. | `.github/workflows/`, `25-…`, `30-…` tests. |
| F11 | P2 | UI says "Jira write-back is not implemented — every Jira interaction is read-only" although V2.35 implemented it. | `app/data-settings/page.tsx` ~L1672–1677. |
| F12 | P2 | `@vercel/kv` is deprecated (npm warns). | `npm ci` output. |
| F13 | P2 | 19 lint warnings: 12 `set-state-in-effect`, 7 unused `eslint-disable`, and `FocusSession.tsx` ~L180 calls an impure function during render. | `eslint` output. |
| F14 | P2 | `datasource/demo-source.ts` and `local-import-source.ts` have no importer in `src/` (only a test). | grep. |
| I1 | Smart | Score ignores Jira priority: P1, P2, P3, P4 all score **1** when other fields are equal; `businessImpact` is always `undefined` for Jira items, so 20 points are dead; an overdue + blocked + P1 ticket without dependency links tops out at 65 (never CRITICAL). | Runnable probe; seed test `36` is red (3/3). |
| I2 | Smart | The app records rich behaviour (ticket status history, skips with reasons, focus outcomes, AI triage acceptance) but none of it feeds ranking; there is no forecasting or cycle-time analytics. | `personal-patterns.ts` is descriptive only; `impact-projection.ts` states "NOT predictive". |
| I3 | Smart | 12 AI features are OFF by default and need up to three gates (toggle + API key + project allow-list); no single place shows per-feature readiness. | `FeatureToggles` defaults. |

---

## 2. Prompts

### P0.1 — Guard rails (release V2.40.1)

````text
Read CLAUDE.md first (copy it from the review pack to the repo root if it is missing). Plan before coding.

GOAL: put guard rails in place before any behaviour change.

TASKS
1. Add CLAUDE.md to the repo root (as provided). Verify every command in it works; fix the file if one does not.
2. Add .github/workflows/ci.yml: triggers push to main + pull_request; permissions contents:read; concurrency group that
   cancels superseded runs; Node 22 with npm cache; steps: npm ci, npx tsc --noEmit, npm run lint, npm test (env
   PERF_BUDGET_FACTOR=3), npm run build.
3. scripts/tests/harness.mts: export perfBudget(ms) = ms * Number(process.env.PERF_BUDGET_FACTOR || 1) (ignore NaN/<=0).
   Use it for SELECTOR_BUDGET_MS (25-performance-budget), ATTENTION_QUEUE_BUDGET_MS and INTERACTION_BUDGET_MS
   (30-perf-interaction-events). Keep the exported constant names; the check message must print the EFFECTIVE budget.
4. Copy the two seed tests from the review pack to scripts/tests/seed/ (35-notify-correctness.test.mts,
   36-priority-signal.test.mts). Do NOT register them in run.mts yet — they are red on purpose; P1.1 and P3.1 move and
   register them.
5. Add npm script "check": tsc --noEmit && eslint . && tsx scripts/tests/run.mts.
6. Bump to 2.40.1, README "Current version" line, one short (V2.40.1) README section.

ACCEPTANCE
- [ ] CI workflow passes on a clean clone (state the run link or the local `act`/manual equivalent).
- [ ] `npm test` locally is unchanged (factor defaults to 1); with PERF_BUDGET_FACTOR=3 the two known perf checks pass.
- [ ] Seed tests exist under scripts/tests/seed/ and are NOT in run.mts.
- [ ] No production source file changed.
````

---

### P1.1 — Notifications & mention correctness (release V2.41.0)

````text
Read CLAUDE.md first. Plan before coding. Red-first: show the failing test before each fix.

CONTEXT (verified)
- cron-notify.ts runServerSideNotifyCheck and server-daily-report.ts runServerDailySnapshot pass a raw ISO string
  (previous.lastCheckedAtIso / baseline.lastRunIso) into fetchMentionedIssuesWith -> JQL `updated >= "2026-10-27T10:15:33.123Z"`.
  JQL accepts only yyyy-MM-dd[ HH:mm] in the Jira user's timezone. The main sync route converts with
  buildIncrementalSinceParam(sinceIso, getJiraTimezoneOffsetMinutes()); these two paths do not. Existing fakes ignore the JQL.
- cron-notify.ts overwrites notifiedCommentIds with only the mention ids found in THIS run -> an unrelated new comment on an
  old ticket re-announces that ticket's old mention.
- collectCurrentMentions swallows per-issue comment-fetch errors, then lastCheckedAtIso still advances -> that mention is
  never fetched again.
- fetchIssueCommentsWith: one page, maxResults=100, no orderBy (Jira default is oldest-first) -> newest comments missed in long threads.
- fetchAssignedIssuesWith: `assignee = X` with no status filter, up to 2,000 issues every tick.

TASKS
1. Move scripts/tests/seed/35-notify-correctness.test.mts to scripts/tests/, append it to FILES in run.mts (after
   34-multi-user-auth). Run it and confirm it is red (5 failing checks) BEFORE changing source.
2. Add `strictJiraFake()` to scripts/tests/helpers.mts: a FetchLike that parses the JQL of /search/jql and answers 400 for an
   `updated >=` value that is not yyyy-MM-dd, yyyy/MM/dd, or either followed by " HH:mm". Use it in the new tests and in every
   existing cron/notify/daily-snapshot test that currently ignores the JQL.
3. Centralize the JQL date: export one formatter from jira/http.ts (same semantics as buildIncrementalSinceParam: tz offset,
   5-minute safety buffer, yyyy-MM-dd HH:mm). Make fetchMentionedIssuesWith / fetchAssignedIssuesWith / buildIssuesJql
   normalize their sinceIso input (accept an ISO string or an already formatted value) so no caller can send a raw ISO.
   Thread a timezoneOffsetMinutes option into runServerSideNotifyCheck and runServerDailySnapshot (callers: sync route GET,
   memberCron — use the member's timezone when sign-in is on; see auth/cron-plan.ts).
4. cron-notify.ts: (a) new baseline = FIFO union(previous.notifiedCommentIds, current ids) capped at 1,000;
   (b) collectCurrentMentions returns { entries, failedKeys }; persist failed keys as optional `retryIssueKeys` (<= 50, FIFO) in
   PersonalNotifyState, fetch them again next run even when the JQL no longer returns them, drop a key only after a successful
   fetch; (c) update the validator in command-center/kv/kv-stores.ts so old blobs without the new field still load.
5. fetchIssueCommentsWith: send orderBy=-created, paginate up to 3 pages while total > fetched. Verify buildMentionEvents,
   latestOwnCommentAt and detectRepliedMentions do not depend on ascending order; add a test with a 130-comment thread whose
   newest comment mentions me.
6. fetchAssignedIssuesWith: add `AND resolution = Unresolved` (or statusCategory != Done — pick the one that is valid for all
   Jira Cloud workflows and say why). Document the edge case: a ticket that leaves and re-enters the unresolved set IS announced.
   Audit server-daily-report.ts for the same unbounded/raw-date patterns and fix them.
7. Audit the browser notify path (use-command-center.ts notify effect, notify.ts computeNewPersonalSignals / buildSlackNotifyPayloads,
   notify-client.ts, assignment-detection.ts) for the same overwrite / advance-on-failure patterns; fix if present, otherwise add a
   regression test proving it is not.
8. Version 2.41.0 (together with P1.2).

ACCEPTANCE
- [ ] Seed test 35 is green; every check was red before the fix (paste the before/after output).
- [ ] No Jira request in any test contains a date outside the documented JQL formats (strictJiraFake enforces it).
- [ ] Steady-state cron run (2nd and later) succeeds against strictJiraFake; no `error` in the result.
- [ ] A mention whose comment fetch failed once is announced on the next successful run, exactly once.
- [ ] A 130-comment thread: the newest mention is detected.
- [ ] Notified-id baseline never exceeds 1,000; retryIssueKeys never exceeds 50.
- [ ] Old KV blobs (without retryIssueKeys) load and the first run behaves like a normal run (no cold-start re-baseline, no flood).
- [ ] Cold-start discipline preserved (first run sends zero Slack messages).
````

---

### P1.2 — Truthful UI copy & dead-code audit (release V2.41.0)

````text
Read CLAUDE.md first.

TASKS
1. app/data-settings/page.tsx (~L1672-1677, "AI provider" panel): remove the claims that Jira write-back "is not implemented"
   and that "every Jira interaction in this app is read-only". Replace with short copy that reflects reality, derived from the
   live flags where practical (features.jiraWriteBack, server write gate status already available in this page).
2. Grep the UI and types.ts header comments for other stale capability claims ("read-only", "not implemented", "Local-only V1:
   no auth, no multi-tenant, no backend", "no backend") and fix those that are false today (sign-in, KV and write-back exist).
3. Add a test in the existing docs/security group style that fails if the removed phrases come back.
4. datasource/demo-source.ts and datasource/local-import-source.ts have no importer in src/ (only scripts/tests/11-work-relevance).
   Verify how Demo and Local Import modes are really served. If the modules are unused by the product, delete them and move the
   test coverage to the real code path; if they should be used, wire them. Explain the decision in the final report.
5. Leave fetchJiraIssuesClassic in place (defensive) but make sure its comment states it is not expected to work on Cloud.

ACCEPTANCE
- [ ] No UI string contradicts a shipped capability (list what you checked).
- [ ] Stale-phrase test exists and is green.
- [ ] Dead-code decision recorded in the report; `npm test` count does not drop except for deleted dead tests (list them).
````

---

### P2.1 — Jira HTTP resilience, bounded concurrency, timeouts, bootstrap window (release V2.42.0)

````text
Read CLAUDE.md first. Plan before coding.

CONTEXT (verified): jira/http.ts classifies 429 but never retries; the sync route, collectCurrentMentions and the daily
snapshot use unbounded Promise.all; no route exports maxDuration (AI client timeout is 55 s); first sync is
`project is not EMPTY order by updated asc` capped at 2,000, so the oldest tickets arrive first.

TASKS
1. jira/http.ts: add one request wrapper used by every fetch*With function. Retries 429/502/503/504 up to 3 times; honours
   Retry-After (seconds or HTTP-date, cap 10 s); otherwise exponential backoff with full jitter; accepts an absolute deadline and
   stops retrying when it passes; sleep and random are injectable. Never retry the Jira write route. Error kinds exposed to the
   UI stay unchanged ("rate-limited", "network-error", …).
2. New jira/concurrency.ts: mapWithConcurrency(items, limit, fn, { deadline }) — preserves order of results, never exceeds `limit`
   in flight, skips remaining items after the deadline (returns which were skipped). Default limit 5, env JIRA_CONCURRENCY (1-10).
   Replace the unbounded Promise.all in: jira/sync/route.ts (changelogs, mention comments, recent-candidate comments),
   cron-notify.ts collectCurrentMentions, server-daily-report.ts.
3. Routes: `export const maxDuration = 60` on jira/sync and ai (document the Vercel plan caveat in README). The sync route
   computes deadline = start + 50 s; optional enrichments (changelogs, mention comments, recent candidates) stop when it is
   exceeded and the response carries `partial: true` plus a warning; the issue data already fetched is always returned.
   Surface `partial` in the existing sync status UI (one line, no new component if avoidable).
4. Bootstrap window: when the sync request has no sinceIso (first/reset sync) add `(statusCategory != Done OR updated >= -90d)`
   to the JQL. Env JIRA_BOOTSTRAP_DAYS (default 90, 0 disables). Make sure it is compatible with `order by updated asc`,
   computeResumeCursor and the client's incremental cursor; add a warning "Initial sync limited to open tickets + last 90 days".
5. Version 2.42.0 (with P2.2-P2.6).

ACCEPTANCE
- [ ] 429 with Retry-After: 2 -> exactly one retry after >= 2 s (fake sleep); 3 consecutive 503 -> same error kind as before.
- [ ] Instrumented fake proves concurrency never exceeds the limit and results keep input order.
- [ ] Deadline exceeded -> `partial: true`, core data returned, no throw; deterministic test with a fake clock.
- [ ] First sync JQL contains the bootstrap clause; incremental sync JQL is byte-identical to today's.
- [ ] Existing sync/mention tests unchanged and green.
````

---

### P2.2 — Unattended-run health: heartbeat, /health, Setup Health, workflow hardening (V2.42.0)

````text
Read CLAUDE.md first.

CONTEXT: "real-time" depends on a cron that can stop silently (secrets missing -> workflow exits 0; GitHub disables scheduled
workflows on public repos after 60 days without repo activity; Vercel cron here is once a day). A failed notify check is only
visible in the cron's HTTP response. lastCheckedAtIso is already stored but never shown.

TASKS
1. New pure module command-center/health.ts: evaluateCronHealth({ lastRunAt, lastOkAt, lastError }, now, expectedMinutes)
   -> { status: OK | LATE | STALE | NEVER | ERROR, ageMinutes, message }. LATE > 2x expected, STALE > 6x. Env
   CRON_EXPECTED_MINUTES (default 20).
2. Heartbeat: at the end of every cron GET write { lastRunAt, lastOkAt, lastError?, durationMs, notified, warnings[<=5] } to KV
   (global key when sign-in is off, per member when on). No KV configured -> no-op. Follow the validator pattern in
   command-center/kv/kv-stores.ts.
3. GET /api/command-center/health (same auth as the other routes; 503 semantics unchanged when misconfigured):
   { version, kv:{configured,reachable}, jira:{configured}, slack:{configured}, ai:{available}, cron:<evaluateCronHealth>,
   schedule:{cronHoursUtc, offsetMinutes, snapshotHourLocal} }. Never any secret or URL.
4. UI: a small "Server check" chip in Header.tsx (OK green / LATE amber / STALE+NEVER+ERROR red, tooltip with the last warning)
   and rows in SetupHealthBanner.tsx. No new page.
5. .github/workflows/sync.yml: when SYNC_URL/CRON_SECRET are missing print a `::warning::` annotation and a step summary
   (still exit 0). Add a best-effort keep-alive step with `permissions: actions: write` that calls the GitHub API to
   re-enable the workflow; note in a comment that the 60-day rule is GitHub's and that this step is best effort.
6. README: add a short "Choosing a scheduler" table (GitHub Actions 15 min / cron-job.org / Upstash QStash / Vercel Pro cron:
   cadence, cost, failure modes, who gets alerted) with a recommendation. Do not change vercel.json.

ACCEPTANCE
- [ ] health.ts has table-driven tests for every status and boundary (exactly 2x, 6x, never run, error with/without lastOkAt).
- [ ] Cron GET writes the heartbeat on success AND on failure; failure never throws out of the route.
- [ ] /health returns no secret (test greps the serialized body for the env values used in the test).
- [ ] Header chip and Setup Health show the same status for the same input (shared selector).
````

---

### P2.3 — Fair scheduling for team cron (V2.42.0)

````text
Read CLAUDE.md first.

CONTEXT: runCronForMembers (jira/cron-tick.ts) processes members sequentially within CRON_RUN_BUDGET_MS and always restarts from
the first member next run; those at the end can starve. planCronMembers is in auth/cron-plan.ts.

TASKS
1. Persist lastProcessedAt per member (KV, same scoping as other per-member records; no-op without KV).
2. planCronMembers orders plans by lastProcessedAt ascending (never processed first); ties by uid for determinism.
3. Report in the cron response: usersProcessed, skipped[], and `oldestWaitMinutes`; include it in the P2.2 heartbeat.

ACCEPTANCE
- [ ] Fake clock, 10 members, budget fits 3 per run: after 4 runs every member was processed at least once; no member is
      skipped twice in a row.
- [ ] A member whose Jira returns 401 is reported and does not block the next member (existing behaviour kept).
- [ ] Single-user mode (sign-in off) is untouched.
````

---

### P2.4 — Replace the deprecated KV client (V2.42.0)

````text
Read CLAUDE.md first. Plan before coding.

CONTEXT: @vercel/kv is deprecated. Consumers: lib/server/kv-client.ts (seam), notify-store.ts, app-state-store.ts,
server-report-store.ts, jira-write-log-store.ts, ai/usage-ledger.ts (usage), auth/users directory.

TASKS
1. Add @upstash/redis; remove @vercel/kv. Keep ONE seam (lib/server/kv-client.ts) — no other file may import the SDK.
2. Detect credentials from KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (first complete
   pair wins). Key names, value shapes, TTLs and "unconfigured = silent no-op" semantics must not change.
3. Add a contract test of the seam against an in-memory fake that implements the subset used (get/set/del/incr/expire/lrange or
   whatever the code actually uses — list it in the report).
4. README env table and Setup Health wording updated; no behaviour change for existing deployments (old env names still work).

ACCEPTANCE
- [ ] `npm ls @vercel/kv` is empty; build and tests green.
- [ ] A grep proves only kv-client.ts imports the Redis SDK.
- [ ] Existing KV-backed tests pass untouched.
````

---

### P2.5 — Live Jira smoke script (V2.42.0)

````text
Read CLAUDE.md first.

CONTEXT: README states "Live Jira validated: NOT AVAILABLE". Several behaviours are inferred (JQL date acceptance, comment
default order, mention search lag). Build a read-only script that settles them on a real instance in one run.

TASKS
1. scripts/jira-smoke.mts + npm script "smoke:jira". Env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, SMOKE_ACCOUNT_ID, optional
   SMOKE_ISSUE_KEY and SMOKE_MENTION_ISSUE_KEY. Read-only: no writes, ever. Never prints the token or Authorization header.
2. Checks, each PASS/WARN/FAIL with a one-line explanation and the raw status code:
   a. auth: GET /rest/api/3/myself matches SMOKE_ACCOUNT_ID.
   b. search: POST /search/jql paging (maxResults 5, follow nextPageToken once); fields priority, resolutiondate,
      statuscategorychangedate present.
   c. JQL dates: try `updated >= "yyyy-MM-dd HH:mm"` (expect 200) and `updated >= "<ISO with T and Z>"` (record 200/400 — this
      settles finding F1) and the user-timezone offset interpretation (compare to JIRA_TIMEZONE_OFFSET_MINUTES).
   d. comments: for SMOKE_ISSUE_KEY fetch default order vs orderBy=-created and report which is newest-first (settles F4).
   e. mentions: `comment ~ "accountid:<id>"` returns SMOKE_MENTION_ISSUE_KEY (WARN if not: indexing lag).
   f. rate limiting: report X-RateLimit / Retry-After headers seen.
3. Output a Markdown table to stdout and a JSON report to ./smoke-report.json (gitignored). Exit 1 on any FAIL.
4. NOT part of `npm test` or CI. Document usage in README (short).

ACCEPTANCE
- [ ] Script runs with fake env against a local stub server in a test (stub verifies read-only: only GET/POST /search/jql).
- [ ] No secret appears in stdout/report (test greps).
- [ ] Final report tells the PO exactly which of F1/F4 are confirmed or refuted on the real instance.
````

---

### P2.6 — Lint & React-correctness cleanup (V2.42.0)

````text
Read CLAUDE.md first.

TASKS
1. Remove the 7 unused eslint-disable directives in use-command-center.ts.
2. Fix react-hooks/set-state-in-effect warnings (data-settings/page.tsx ~L730, AiDataProtectionPanel ~L60, JiraWriteBackPanel ~L30,
   JiraWriteBackPrompt ~L53, MorningMode ~L66/L125, Nav ~L103, TakeActionPanel ~L51, FocusSession ~L215) by deriving state during
   render, keying the component, or moving the work to an event handler. Behaviour must not change.
3. FocusSession.tsx ~L180: impure call during render (a clock/random read) — read it once via useState initializer/ref or lift
   it into the handler. Fix the dependency-list warning at ~L203.
4. AuthGate.tsx ~L49: use the router instead of window.location.href unless a full reload is intentional (then comment why and
   suppress with a specific, justified disable).
5. CI: switch lint to `eslint . --max-warnings 0`.

ACCEPTANCE
- [ ] `npm run lint` reports 0 errors and 0 warnings.
- [ ] Page smoke tests (C3) and Focus Session tests unchanged and green.
- [ ] Manual check list in the report: Morning Mode, Focus Session start/complete/block, Nav morning redirect, Take Action panel.
````

---

### P3.1 — Priority Score v2 (release V2.43.0)

````text
Read CLAUDE.md first. Plan before coding; show the weight table for approval in the plan.

CONTEXT (verified): scoring.ts scoreWorkItem never reads item.priority; for Jira items businessImpact is always undefined, so up
to 20 points are dead. With everything else equal P1,P2,P3,P4 all score 1. An overdue, blocked, P1 ticket without dependency
links caps at 65 (HIGH, never CRITICAL).

TASKS
1. Move scripts/tests/seed/36-priority-signal.test.mts to scripts/tests/ and register it; confirm red (3 failures) first.
2. Add `ScoreModel = "v1" | "v2"`. scoreWorkItem / scoreAllWorkItems / eligibilityScore get an optional trailing `model` parameter
   defaulting to "v1" so every existing test and call keeps its exact output. v2 is a separate, pure implementation.
3. v2 factors (max 100; a factor with no data contributes 0 and lowers `confidence`, never a made-up value):
   Priority 20 (P1 20 · P2 14 · P3 7 · P4 0; if Jira gave no priority treat as unknown: 0 and -0.05 confidence — add a
   `priorityKnown` flag in jira/normalize.ts instead of trusting mapPriority's "P3" default), Deadline 20 (as v1),
   Awaiting-me 15 (an unanswered mention of me, or a ticket waiting on my reply; scaled by age against the blocker/reply SLA in
   business days — use the existing mention-reply state; P3.2 will extend the signal), Blocker 15, Dependency 10, Aging 10
   (prefer statusCategoryChangedAt when present, else lastUpdated), Change frequency 5, Ownership 5. When businessImpact IS defined
   (demo/import data) keep it: Business impact 0-10 and Priority scaled to 10 so the total stays 100.
   Classification thresholds unchanged (80/60/40). Rework eligibilityScore consistently (rescale by the factors that can speak).
4. Setting `scoringModel` ("v1" | "v2", default "v2") in state with a tiny control in Data & Settings -> Features. Thread it from
   use-command-center.ts / selectors to every caller: action-plan.ts, client-attention-map.ts, memory.ts and the PriorityCard path.
5. Daily snapshots record the model used; trend code must not compare scores across models (show "model changed on <date>").
6. reasoning text names the top two contributing factors, e.g. "Priority P1 (Highest in Jira) and overdue by 3 days".
7. Report (not assert) in the PR: on the demo dataset, how many of the top-10 changed between v1 and v2, and why.

ACCEPTANCE
- [ ] Seed test 36 green; all pre-existing tests green with default `v1` calls untouched.
- [ ] Unit tests: each factor's boundaries; unknown priority; businessImpact defined/undefined; confidence deltas; eligibility rescale.
- [ ] Switching the model in settings changes Priorities/Action Plan order; switching back restores the old order exactly.
- [ ] Old stored state without `scoringModel` loads (defaults to v2) — parse test.
- [ ] Performance: selectors stay within perfBudget on the 3,000-item fixture.
````

---

### P3.2 — Ball-in-court intelligence (release V2.43.0)

````text
Read CLAUDE.md first. Depends on P2.1 (mapWithConcurrency, deadline) and P1.1 (comment ordering).

GOAL: know who the ball is with for the tickets that matter, at bounded Jira cost.

TASKS
1. After the main fetch in the sync route, pick at most CONVERSATION_ENRICH_CAP (env, default 25) open tickets: assigned to me,
   blocked, mentioned, or top-scored. Skip any whose (key, updatedAt) is unchanged since the client's cached ConversationState
   (client sends the cache keys + updatedAt, not content). Fetch /comment?orderBy=-created&maxResults=5 via mapWithConcurrency
   inside the sync deadline.
2. Pure module conversation-state.ts -> ConversationState { lastCommentAt, lastByAccountId, lastByName, lastIsMe, lastExternalAt,
   myLastAt, awaiting: "ME" | "THEM" | "NONE", sinceAt }. Rules: AWAITING_ME when the newest external comment is newer than my last
   comment and (it mentions me or I am the assignee); AWAITING_THEM when my comment is the newest, the ticket is open, and it is
   >= 1 business day old; else NONE. Deterministic, no AI.
3. Return `conversation: Record<key, ConversationState>` as an optional field of the sync response; the client merges it into a new
   optional state field `conversationByTicket` (derived data: not synced across devices; pruned to open tickets).
4. UI: chip on TaskRow ("Awaiting you · 2d", "Awaiting them · 3d"), a My Work filter, and a "Needs a nudge" group (AWAITING_THEM
   past the blocker SLA) that reuses blocker-followup.ts drafts. Feed AWAITING_ME into the P3.1 Awaiting-me factor.
5. Version 2.43.0 (with P3.1, P3.3).

ACCEPTANCE
- [ ] Never more than CONVERSATION_ENRICH_CAP comment requests per sync (fake counts them); cached tickets cause zero requests.
- [ ] Table-driven tests for every awaiting rule incl. mention-of-me vs not, my reply newest, closed ticket, missing accountId.
- [ ] A sync without accountId or without a conversation field behaves exactly as before.
- [ ] Chip text agrees with the Needs-a-nudge list for the same ticket (shared selector).
````

---

### P3.3 — Personal learning loop, shadow mode first (release V2.43.0)

````text
Read CLAUDE.md first. Plan before coding; the design below is the contract — flag anything you cannot honour.

GOAL: let the ranking adapt to how THIS user actually works, explainably and reversibly. No AI tokens, no network.

SIGNALS (all already stored): ticketWorkStates[*].history (from->to, at, surface, reason), personalPlan outcomes, attentionState
lifecycle timestamps, AI-triage acceptance stats (ai/smart-triage.ts), action effectiveness.

TASKS
1. Pure module learned-adjustments.ts. Group key = (projectId, issueType, priority, firstSignalKind). Window 45 days,
   recency-weighted, minimum n = 6 per group. Outcome per appearance in Today = acted on (DONE / IN_PROGRESS / BLOCKED with a
   real reason) within 2 business days vs ignored/skipped/deferred. delta = clamp(round(8 * (groupRate - overallRate)), -8, +8).
   Decay: halve a delta's weight when its newest sample is older than 30 days.
2. HARD RULES WIN: never apply a negative delta to a ticket that is overdue, blocked, P1, or awaiting-me past SLA.
3. Surface as a score factor "Learned (you)" (max 8) in PriorityScoreResult.factors with `detail` = evidence ("You completed 9 of
   11 JPMC P2 mentions within 2 days, n=11"). Label LEARNED.
4. Mode `learnedPriority: "off" | "shadow" | "on"`, default "shadow": in shadow the factor is computed and shown as a quiet chip
   ("Learning would move this +4") but does NOT change scores/order. Weekly Review proposes switching to "on" after 14 days of shadow
   data with the evidence of what would have changed.
5. New component LearningPanel in Data & Settings (do not grow page.tsx beyond mounting it): mode select, table of current
   adjustments (group, delta, n, evidence), "Reset learning" (clears derived cache and records a memory event), export as JSON.
6. Weekly Review: "What learning changed this week" (top 3 moves, with evidence).
7. Guard against feedback loops: the weekly list also shows what learning DE-prioritised, so nothing disappears silently.

ACCEPTANCE
- [ ] Deterministic: same inputs -> same deltas (no clock reads inside; today is passed in).
- [ ] n < 6 -> no adjustment; |delta| <= 8; decay applied; hard-rule exemptions proven by tests.
- [ ] Shadow mode: rankings are byte-identical to learnedPriority "off" (test over the 3,000-item fixture).
- [ ] "on": a seeded history that consistently skips group X lowers X by the expected delta; a seeded history that always acts on Y raises Y.
- [ ] Reset returns scores to the un-learned values; mode persists across reload; old state without the field loads as "shadow".
- [ ] Every chip/factor shows its evidence and sample size; no AI call is made (test asserts the AI route is never invoked).
````

---

### P3.4 — Delivery forecast (release V2.44.0)

````text
Read CLAUDE.md first. Plan before coding. Label everything FORECAST with sample size; never present a number without it.

DATA AVAILABLE (verified): WorkItem.createdDate, resolvedAt (resolutiondate), statusCategoryChangedAt, status, type, priority,
projectId, fixVersion, dueDate; snapshotHistory (60 days). Caveat: only synced issues exist (open + recent closed; see the
bootstrap window in P2.1) — state this in the UI.

TASKS
1. forecast/lead-time.ts: lead-time distribution (created -> resolved) per (project, type) over the last 90 days of resolved items:
   P50/P85/P95. Minimum 8 samples; otherwise fall back to project-wide, then global, else UNKNOWN ("insufficient history").
2. forecast/aging.ts: for an open ticket, time in current status category vs the P85 of comparable tickets -> "older than 85% of
   similar tickets" (EVIDENCE + FORECAST).
3. forecast/slip-risk.ts: open ticket with dueDate: remainingDays vs expected remaining time (max(0, P50 - age)) -> LOW/MEDIUM/HIGH
   with the numbers in the explanation.
4. forecast/release-forecast.ts: for a fixVersion with a target date (latest dueDate among its items, or the user-entered
   release date if one exists): remaining count vs historical weekly throughput of the project (resample the last 8 weeks) ->
   P50..P85 completion date range and probability of landing by the target. Deterministic (seeded PRNG if sampling is used; seed
   = hash(projectId + today)).
5. Integrate, no new nav page: (a) new auto-risk rule "forecast-slip" (extend RiskRuleId, identityKey = item id, add to
   riskFingerprint handling and dedupe tests); (b) ForecastCard on the Executive view and in ReleaseHealthPanel; (c) a quiet chip on
   PriorityCard/TaskRow when aging > P85 or slip risk is HIGH; (d) one line in the weekly review.
6. Performance: whole forecast layer < perfBudget(100) ms on the 3,000-item fixture (add to the perf test).

ACCEPTANCE
- [ ] Table-driven tests: percentiles on known samples, fallback chain, UNKNOWN below minimum, deterministic output for a fixed seed.
- [ ] Slip risk boundaries tested (due today, overdue, no dueDate -> not computed).
- [ ] No forecast is shown without "n = …"; UNKNOWN is shown as "insufficient history", never as zero or a default.
- [ ] forecast-slip risks dedupe across syncs (same fingerprint) and resolve when the ticket is Done.
- [ ] Old state loads; no new persisted state (forecast is derived).
````

---

### P3.5 — Smart notifications (release V2.44.0)

````text
Read CLAUDE.md first. Depends on P1.1, P2.2, P3.2.

GOAL: fewer, better notifications — routed by importance, quiet when you are off, escalated when something is ignored.
Default behaviour must equal today's (immediate, everything) so nothing changes until the user opts in.

TASKS
1. NotifyPrefs { mode: "immediate" | "digest-hourly" | "digest-daily", quietHours?: { start: "HH:mm", end: "HH:mm" },
   immediateKinds: ("ASSIGNMENT_P1P2" | "MENTION_URGENT" | "ESCALATION")[], mutedProjects: string[], maxPerRun: number }.
   Stored where the cron can read it without a browser: a small KV record scoped like notify-state, read/written through the
   existing /api/command-center/notify route (zod-validated, same auth). Defaults reproduce current behaviour.
2. Pure severity classifier: URGENT when priority P1/P2, overdue, blocked, or the mention is on such a ticket; else NORMAL.
   URGENT bypasses quiet hours only if listed in immediateKinds.
3. Digest queue in KV (<= 100 items): NORMAL signals during quiet hours or in digest mode are queued and flushed as ONE Slack message
   when due / when quiet hours end. Flood guard: more than maxPerRun signals in a run -> first N + "+M more" summary.
4. Escalation: an AWAITING_ME mention (P3.2) unanswered past the reply SLA is re-announced once (`escalatedCommentIds`, <= 500 FIFO).
   Reply detection uses the comments the notify check already fetches (latestOwnCommentAt).
5. Slack text: priority marker, age, one-line reason, link. Keep renderSlackText backward compatible for the browser path.
6. Quiet hours use the member's timezone (profile) or JIRA_TIMEZONE_OFFSET_MINUTES; handle ranges that cross midnight.
7. Settings UI: a compact panel in the existing Slack Notifications section (new component, mounted only).

ACCEPTANCE
- [ ] Default prefs: byte-identical Slack output and counts to V2.41 behaviour (regression test with the P1.1 fixtures).
- [ ] Quiet hours across midnight, DST-free fixed offsets, boundary minute inclusive/exclusive documented and tested.
- [ ] Digest flush sends exactly one message and clears the queue; a failed Slack post keeps the queue.
- [ ] Idempotent: running the same cron tick twice never duplicates a signal or an escalation.
- [ ] Cold start still sends nothing; muted project never notifies.
````

---

### P3.6 — Next Best Action (release V2.44.0)

````text
Read CLAUDE.md first. Depends on P3.1–P3.4. No new nav page; no new AI task.

GOAL: replace "here is a list" with "do this next, and here is why" — deterministic, explainable, learnable.

TASKS
1. Pure module next-best-action.ts: nextBestActions(derived, now) -> up to 3 { id, kind, ticketKey?, headline, why: Evidence[],
   primary: { label, intent }, rank }. Rank order (documented in code): awaiting-me past SLA > overdue P1/P2 > forecast slip HIGH >
   blocked past SLA with a nudge ready > due re-check today > highest Score v2. Dedupe by ticket; skip DONE/SKIPPED/DEFERRED-future.
2. Placement: top of My Work -> Today, the last step of Morning Mode, and one strip in the Command Center header. Primary buttons
   reuse existing flows: Start focus, Draft reply (mention-reply drafter), Nudge (blocker follow-up), Defer.
3. Feedback: "Useful" / "Not now" on each card, recorded as memory events (extend the memory event type) NBA_ACCEPTED /
   NBA_DISMISSED with kind + ticket + reason; P3.3 uses them as extra signals (weight lower than real status changes).
4. Optional narration: reuse the existing generateDailyGuidance task (fast tier) — at most one call per day, cached by a hash of
   the facts, only when AI is configured and its flag is on; deterministic text otherwise. No new schema unless unavoidable.

ACCEPTANCE
- [ ] Ranking tests for each rule and for ties (stable, deterministic); never more than 3; never a Done/Skipped ticket.
- [ ] Every card shows its evidence; "Why?" opens the existing drawer with the same facts.
- [ ] Feedback events persist and sync like other memory events; old state loads.
- [ ] AI off or capped -> identical structure with deterministic wording; AI on -> max 1 call/day (test with a counting fake).
````

---

### P3.7 — AI readiness & presets (release V2.44.0)

````text
Read CLAUDE.md first.

CONTEXT: 12 AI features default OFF and can need three gates (toggle, ANTHROPIC_API_KEY, project allow-list + optional server
AI_ALLOWED_PROJECT_KEYS). Users cannot see which gate blocks which feature.

TASKS
1. Pure ai/readiness.ts: per feature -> { state: READY | OFF | NEEDS_KEY | NEEDS_ALLOWLIST | SERVER_POLICY_BLOCKED | CAP_REACHED,
   nextStep: string, projects: { allowed, total } }. Inputs come from existing status endpoints (ai/status-response.ts, usage).
2. AiReadinessPanel in Data & Settings (new component, mount only) as a matrix, plus one shared hook used by every AI button for
   its disabled tooltip (replace ad-hoc texts).
3. Presets: "Recommended" turns on smartTriage, ticketBrief, weeklyInsights; "All off". Presets NEVER touch the project allow-list
   and show a diff before applying.
4. Models: before changing any default, check Anthropic's current model docs (do not trust memory). If a newer fast-tier model than
   claude-haiku-4-5 is generally available, propose the change in the PR with price/latency notes, update
   DEFAULT_AI_MODEL_FAST and isAlwaysThinkingModel's pattern together, and keep the ANTHROPIC_MODEL_* overrides.

ACCEPTANCE
- [ ] Table-driven readiness tests for every state and precedence (OFF beats NEEDS_KEY, etc.).
- [ ] Every AI button's disabled reason equals the readiness nextStep (shared hook; test over all 12 features).
- [ ] Preset apply/undo round-trips; allow-list untouched (test).
- [ ] Model change (if any) is documented and covered by model-config tests.
````

---

## 3. Phase 4 — platform & commercialization backlog (no prompts yet)

Prioritized for turning Daily Command into a product, in this order:

1. **Jira OAuth 2.0 (3LO)** instead of storing per-user API tokens — the single biggest trust/sales blocker for a team or paid offer.
2. **Durable team data** (Postgres, tenant-scoped) instead of KV blobs once more than ~10 members or real audit/retention needs appear; keep `kv-client.ts` as the seam to make this a swap.
3. **Auth.js v5** (NextAuth v4 is in maintenance) when touching sign-in again.
4. **Slack/Teams app with interactive buttons** (Acknowledge / Snooze / Done / Draft reply) — webhooks cannot do this; pairs with P3.5.
5. **Optional Jira webhook ingestion** for admins (replaces polling, true real-time); polling stays the default for non-admin users.
6. **Usage metering & plans**: the AI usage ledger already records per member — expose per-seat limits and billing hooks.
7. **Observability** (Sentry/OpenTelemetry), **Playwright E2E** for 5 golden flows (Morning Mode, triage, focus session, notify setup, report send), **README split** into `docs/` (the README is ~77 KB with release history back to V2.2).
8. **Onboarding wizard** that walks Jira → Slack → scheduler → AI preset using the P2.2 health and P3.7 readiness data.
