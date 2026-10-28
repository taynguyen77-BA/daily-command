# Daily Command — Round 2: Completion Prompts (V2.44.0 → V2.45.0)

Reviewed: `daily-command-main (1).zip` @ **V2.44.0**. Measured by the reviewer on a clean install:
`tsc` clean · `eslint --max-warnings 0` clean · `next build` OK (incl. new `/api/command-center/health`) ·
`npm test` **4,024 / 4,026** (the 2 failures are wall-clock perf budgets, see C3) · 3 skipped (`navigator.locks`).

Not verifiable by the reviewer: live Jira / live Claude / real browser. Run the PO runbook (section 4) for those.

Use the same working method as round 1: read `CLAUDE.md`, plan first, red-first, one prompt ≈ one PR, Definition of Done from `CLAUDE.md`.

---

## 1. What round 1 delivered (verified)

| Prompt | Verdict | Note |
|---|---|---|
| P0.1 CI, `perfBudget`, `check` script | Done | `ci.yml` runs tsc, eslint (0 warnings), tests (factor 3), build. |
| P1.1 notify/mention correctness | Done, **1 gap (R1)** | Union baseline, retry keys, strict-JQL fake, `formatJqlSince`, newest-first paginated comments, open-work assigned query all verified in code + tests. |
| P1.2 truthful copy | Done | Stale "write-back not implemented" text gone; dead `datasource/*-source.ts` removed. |
| P2.1 Jira resilience | Done, 1 edge (R5) | `withJiraRetry`, `mapWithConcurrency`, `maxDuration=60` on sync + AI, `partial`, bootstrap window. |
| P2.2 health/heartbeat/workflow | Done, **1 gap (R4)** | Beyond the prompt: Claude Code found the 15-min workflow sent **POST** (a full sync nobody reads) and switched it to **GET** — so the cadence never notified before. |
| P2.3–P2.6 fair cron, Upstash seam, smoke script, lint | Done | `@vercel/kv` gone; smoke is read-only and redacts secrets; lint 0/0. |
| P3.1 Score v2 | Done, **1 gap (R3)** | Threaded through action plan, attention map, memory, selectors, weekly review. |
| P3.2–P3.7 conversation, learning (shadow default), forecast, smart notify, NBA, AI readiness | Done | Every new module has a production importer (no orphan code). Monolith growth contained (store.ts +58, types.ts +24, data-settings +13). |

---

## 2. New findings (evidence)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| R1 | **P0** | **A Slack outage permanently loses notifications.** On the default path a failed `postToSlack` only fails to increment `delivered`; the baseline (`notifiedCommentIds`, `assignedIssueKeys`) still advances, so the mention/assignment is never announced again. | Runnable repro; seed test `50` group R1 is red (4 checks). `cron-notify.ts` default branch `for (const signal of signals) …` then `store.set(nextState)`. |
| R2 | **P1** | **JQL day-level fallback skips hours west of UTC.** With no `JIRA_TIMEZONE_OFFSET_MINUTES`, the cursor is the UTC date; Jira reads it in the user's timezone, so for a New York user a 21:00-local check yields `2026-10-28` = 04:00Z and the 3 h in between are missed. A fixed offset is also DST-blind (1 h error half the year). | `formatJqlSince("2026-10-28T01:00:00.000Z", undefined)` → `2026-10-28`; seed test `50` group R2 red. |
| R3 | P1 | **Release Health still scores with v1.** `selectReleaseHealth` calls `scoreAllWorkItems(releaseData, today, workRelevanceIndex)` with no scoring options, so `deliveryConfidence` (and the Go/No-Go inputs) ignore Jira priority while every other surface uses v2. | `release-health.ts` ~L75; the only call site not passing `scoring`. |
| R4 | P2 | **Unauthenticated status endpoints grow.** With sign-in off, `GET /api/command-center/health` and `GET /api/command-center/notify` answer anyone: version, which services are configured, and (new) the user's notify prefs incl. muted project keys; `health` also issues a KV read per request. No secrets leak, but it is reconnaissance + a cost amplifier. | `health/route.ts`, `notify/route.ts` GET. Existing precedent: `/jira/status` returns only `{configured}` to unauthenticated callers. |
| R5 | P2 | **Bootstrap clause is dropped on a truncated first sync.** The `(statusCategory != Done OR updated >= -90d)` clause is only added when there is no cursor; if the first sync hits the 2,000 cap, the resume sync uses `updated >= <cursor>` without it and can pull years of closed tickets again. | `sync/route.ts` `bootstrapDays = jqlSinceIso ? 0 : …`. Rare (needs > 2,000 open+recent issues). |
| R6 | P3 | Learning loop compares `t.at.slice(0,10)` (UTC date) with `plannedDate` (local date): actions in the first hours of the local day can land in the previous day's window. | `learned-adjustments.ts` `collectAppearances`. |
| R7 | P3 | `npm test` is red on a normal laptop at factor 1: in the full suite the attention-queue check measured 264 ms vs 100 ms and the interaction median 430 ms vs 250 ms, while the same checks run standalone on the same machine measure ≈ V2.40 (≈ 100 ms / ≈ 300 ms). Heap pressure from 50 files in one process, not a selector regression. A suite that is red by default stops being trusted. | A/B run of `30-perf-interaction-events` on V2.40 vs V2.44: equal within noise. |
| R8 | P3 | README grew 77 KB → 95 KB (release history back to V2.2 still inline). | `wc -c README.md`. |

**To verify (not proven):** whether the smart-notify path (`runSmartDelivery`) keeps an item queued when its own Slack post fails — C1 asks for a test either way.

---

## 3. Prompts

### C1 — Delivery guarantees & timezone-correct cursors (release V2.44.1)

````text
Read CLAUDE.md first. Plan before coding. Red-first.

CONTEXT (verified): the review pack contains the seed test 50-delivery-and-cursor.test.mts (put it in the repo first). Today, in cron-notify.ts
runServerSideNotifyCheck, a failed Slack post still advances the baseline, so the mention/assignment is lost. And
formatJqlSince without a tz offset returns the UTC date, which skips hours for Jira users west of UTC; the fixed
JIRA_TIMEZONE_OFFSET_MINUTES is DST-blind.

TASKS
1. Place the seed at scripts/tests/50-delivery-and-cursor.test.mts, append to FILES in run.mts, show it RED (4 failing checks).
2. Delivery guarantee (cron-notify.ts, default path AND the P3.5 smart path):
   - When a webhook is configured, a signal counts as notified only if its Slack post succeeded.
   - Undelivered mention: do NOT add its commentId to notifiedCommentIds; add its issue key to retryIssueKeys (already
     supported) so it is re-fetched even if the JQL no longer matches it.
   - Undelivered assignment: remove its key from the next assignedIssueKeys so it diffs as new again.
   - Bound the retries: per-signal attempt counter (optional state field `deliveryAttempts`, <= 100 entries, FIFO). After 5
     failed attempts drop the signal, count it in the heartbeat (`droppedUndelivered`) and warn. Never retry forever.
   - Flood guard on recovery: after an outage deliver at most maxPerRun (default 10) per run and put the rest in ONE
     summary line ("+N more") — reuse the P3.5 flood guard.
   - NO webhook configured: unchanged (baseline advances, a webhook added later does not flood old signals).
   - Postmortem for the smart path: write a test with non-default prefs where the Slack post fails; the item must stay in
     the digest queue and be delivered later exactly once. Fix if it does not.
3. Surface it: heartbeat gets { lastSlackError?, undelivered, droppedUndelivered }; ServerCheckChip tooltip and Setup Health
   show "Slack delivery failing since <time>" when undelivered > 0.
4. Timezone-correct cursor:
   a. Extend jira/http.ts formatJqlSince with a resolution order: IANA zone (new optional input) -> fixed offset
      (JIRA_TIMEZONE_OFFSET_MINUTES) -> safe fallback. IANA must be converted with Intl.DateTimeFormat at the cursor's instant
      (DST-aware). The safe fallback is the UTC date MINUS ONE DAY (a wider window is harmless: comment ids and the
      assigned diff dedupe).
   b. Learn the zone from Jira: GET /rest/api/3/myself returns `timeZone` (IANA). Read it where /myself is already called
      (team mode: connecting Jira in My account — store it on the member profile; single-user: resolve lazily once and cache
      in the notify KV record, refresh weekly). Env override JIRA_TIMEZONE (IANA) wins; JIRA_TIMEZONE_OFFSET_MINUTES stays
      supported.
   c. Add a `timeZone` check to scripts/jira-smoke.mts (PASS when /myself returns a valid IANA zone and it agrees with the
      configured offset at "now"; WARN on disagreement — that is the DST symptom).
   d. Setup Health: replace the current "offset not set" wording with the zone actually in use and where it came from.
5. Version 2.44.1.

ACCEPTANCE
- [ ] Seed 50 is green; every check was red before (paste before/after).
- [ ] Slack down for N runs then up: each pending mention/assignment is announced exactly once; 6th failed attempt is dropped and counted.
- [ ] A recovered outage with 30 queued signals sends <= 10 + one summary, then drains over later runs without duplicates.
- [ ] Idempotent: running the same tick twice while Slack is up never duplicates.
- [ ] formatJqlSince: America/New_York across both DST transitions, Asia/Ho_Chi_Minh, UTC, no-zone fallback — table-driven tests;
      fallback is never later than the local day for any zone >= UTC-12.
- [ ] Old KV blobs without deliveryAttempts / heartbeat fields still load.
- [ ] No existing test deleted or weakened.
````

---

### C2 — Consistency & exposure (release V2.45.0)

````text
Read CLAUDE.md first. Plan before coding.

TASKS
1. R3 — Release Health uses the same scoring model as the rest of the app.
   Thread the scoring options (the object use-command-center passes to selectors.ts) into selectReleaseHealth,
   selectAllReleaseHealth and computeReleaseHealth as an optional trailing parameter (omitted = v1, so all existing tests keep
   their outputs), and pass it from every caller (ReleaseHealthPanel, ExecutiveView, release go/no-go inputs, reports).
   Tests: same release with a P1-heavy vs a P4-heavy open set -> under v2 the P1 set has lower deliveryConfidence; under v1
   the two are equal (documents the old blind spot); switching the model in settings changes Release Health.
2. R4 — Status endpoints in single-user mode.
   - GET /api/command-center/health and GET /api/command-center/notify: an unauthenticated caller gets only { ok: true } /
     { configured } (same contract as /jira/status). Full body (version, kv, jira/slack/ai flags, cron judgement, schedule,
     prefs) only for a paired caller (Authorization: Bearer APP_STATE_SECRET via the existing checkSyncRequestAuth) or a signed-in
     member. Prefs must never be returned to an unauthenticated caller.
   - health: memoize the KV reachability probe for 30 s per instance (no KV call per request).
   - Update the client (health-client.ts, notify-client.ts) to send the pairing header it already uses elsewhere.
   Tests: unauthenticated / paired / signed-in / misconfigured (503) for both routes; the unauthenticated body contains no
   version, no prefs, no project keys (grep the serialized body); KV probe called once for N requests inside 30 s.
3. R5 — keep the bootstrap clause through a truncated first sync.
   Persist `initialSyncComplete` (optional state field, default true for existing installs so nothing changes for them). While
   it is false, every resume sync JQL is `updated >= <cursor> AND (statusCategory != Done OR updated >= -Nd)`. Set it true on the
   first sync that is not truncated. Test with a fake that returns > JIRA_MAX_ISSUES.
4. R6 — in learned-adjustments.ts compare dates in the SAME zone: convert history timestamps to the user's local date (pass the
   offset/IANA zone in, as with the other time-aware modules) instead of slicing the UTC string. Test an action at 00:30 local
   (UTC+7) lands in the right day's window.
5. Version 2.45.0.

ACCEPTANCE
- [ ] Every scoreAllWorkItems/scoreWorkItem caller outside tests passes the scoring options (grep proves it; list any deliberate v1 use with a comment).
- [ ] Unauthenticated bodies are minimal; existing authenticated behaviour unchanged; Setup Health / chip still work when paired.
- [ ] A truncated first sync followed by its resume never queries closed tickets older than the bootstrap window.
- [ ] Existing persisted state loads with initialSyncComplete defaulting to true.
````

---

### C3 — Trustworthy test suite & docs hygiene (release V2.45.0)

````text
Read CLAUDE.md first.

CONTEXT: `npm test` is red on a normal machine because two wall-clock budgets (attention queue 100 ms, interaction 250 ms) are
measured inside a single process that has already run 48 files (heap pressure). Standalone they pass. README is 95 KB.

TASKS
1. Perf checks move out of the shared process: run.mts keeps running every functional file first, then runs the two perf files in
   a CHILD process (tsx) so they start with a clean heap. Their output is relayed and counted in the totals. Keep
   `npm test` as the single entry point and keep PERF_BUDGET_FACTOR. Add `npm run test:perf` to run just them.
2. Make the measurement robust: warm-up run discarded; report the median of 5; print the machine-independent selector
   count alongside the ms so a regression is visible even when the budget passes.
3. Docs: split README.md into README.md (<= ~25 KB: what it is, getting started, env table, feature index, version line) and
   docs/ (RELEASE-NOTES.md for the V2.x history, CONFIG.md for env/setup, TASK-STATE.md pointing at AUDIT_TASK_STATE.md).
   Constraints: keep exactly one "**Current version:** V2.NN" line in README.md; keep every phrase that tests in
   19-security-and-docs and others grep for (find them first: grep scripts/tests for readFileSync("README.md")/read("README.md")
   and update those tests to read the new files rather than deleting assertions). Move, do not rewrite.
4. Move daily-command-claude-code-prompts.md and the round-2 file into docs/prompts/.
5. Version 2.45.0 (with C2).

ACCEPTANCE
- [ ] `npm test` on a laptop at factor 1 is green (state the machine) — and CI at factor 3 is green.
- [ ] No test assertion removed; README-related tests now read the new locations and still assert the same facts.
- [ ] README.md <= 30 KB; no information lost (every removed section exists verbatim under docs/).
````

---

## 4. PO runbook — production acceptance (you run this, ~1 hour)

These cannot be proven offline. Do them in order after C1 is deployed.

1. **Config** — Vercel env: `CRON_SECRET`, `APP_STATE_SECRET` (or sign-in vars), Upstash KV (`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`), `PERSONAL_JIRA_ACCOUNT_ID`, `SLACK_WEBHOOK_URL`, Jira creds, `JIRA_TIMEZONE_OFFSET_MINUTES` (until C1 ships). GitHub repo secrets: `SYNC_URL`, `CRON_SECRET`.
2. **Settle the assumptions** — `npm run smoke:jira` against your real Jira (read-only). Record: (a) does Jira accept the ISO-with-`T…Z` date in JQL (finding F1), (b) comment order with and without `orderBy=-created` (F4), (c) mention search finds a known mention, (d) the Jira user's `timeZone`. Paste the report back to me.
3. **Scheduler** — run the `Jira sync (scheduled)` workflow manually (`workflow_dispatch`): it must be green and the header **Server check** chip must turn OK within ~20 minutes. If it stays NEVER/LATE, the scheduler is the problem, not the app.
4. **Notify drill** — ask a colleague to @mention you on a ticket: Slack within ~15–20 minutes. Then add an unrelated comment to the same ticket: **no** second Slack message.
5. **Outage drill (after C1)** — temporarily set an invalid webhook, get mentioned, restore the webhook: the mention arrives once.
6. **Ranking** — in Data & Settings toggle Scoring model v1 ↔ v2 and compare your Top 5; note anything that feels wrong. Leave Learning in `shadow`; review "What learning changed" in Weekly Review after 14 days before switching to `on`.
7. **AI** — open AI readiness; apply "Recommended" preset; confirm the allow-list is untouched; generate one Ticket Brief on an allow-listed project.

## 5. After this: Phase 4 (platform / commercialization)

Start with **Jira OAuth 2.0 (3LO)** — it removes stored API tokens, the largest blocker to offering this to other teams — then durable tenant-scoped storage and a Slack app with interactive buttons. Ask for the Phase 4 prompts when C1–C3 are merged and the runbook above is green.
