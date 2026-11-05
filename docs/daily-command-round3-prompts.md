# Daily Command — Round 3 Prompts (V2.45.0 → V2.48.0)

Reviewed: `daily-command-main (6).zip` @ **V2.45.0**, clean install. `tsc` clean · `eslint --max-warnings 0` clean · `next build` OK ·
`npm test` **4,116 / 4,117** (the one failure is the attention-queue perf budget: 119.8 ms vs 100 ms on a slow sandbox; CI uses factor 3) · 3 skipped.

Not verifiable by the reviewer: live Jira, **live Claude (no API key was available — every AI conclusion below is from code + probes, not from real model output)**, real browser.

Method for every prompt: read `CLAUDE.md`, plan first, red-first, one prompt ≈ one PR, Definition of Done from `CLAUDE.md`.
Acceptance criteria are checklists grouped by happy path / validation / error / edge.

---

## 0. Release plan

| Release | Prompts | Theme |
|---|---|---|
| V2.46.0 | **D1, D2, D3** | AI actually works: provider setup UI, answer quality, self-test |
| V2.47.0 | **D4, D5** | Never forget a parked task (Reminder Center) + forecast/severity correctness |
| V2.48.0 | **W1, W2, W3** | Proactive Morning Briefing, Sprint Readiness Radar, Blast Radius |
| later | W4, W5 | Ask-My-Work agent, PWA + Web Push |

Run D1 first: nothing in D2/D3 can be validated until a key is configured.

---

## 1. Verdict on what was built (requirement 1)

| Area | Verdict | Evidence |
|---|---|---|
| Notify delivery guarantees (C1) | **Works** | Failed Slack posts stay "owed", bounded retries, flood guard, idempotent; read line-by-line + seed 50/51 green. |
| Timezone / JQL cursor (C1) | Works | IANA zone learned from `/myself`, DST-aware, safe fallback. |
| Status endpoints hardening (C2/R4) | Works | Unauthenticated `/health` returns the minimal body. |
| Release Health uses v2 (C2/R3) | Works | |
| Test suite / README split (C3) | Works | perf in a child process; 4,117 checks. |
| Score v2 | **Works but mis-calibrated (T2)** | Priority now counts, but severity labels are unreachable (below). |
| Forecast (P3.4) | **Bug (T1)** | Slip risk is inverted for old tickets. |
| Learning loop, conversation state, smart notify, NBA, AI readiness, health chip | Works per tests; unprobed live | Shadow mode default is the right call. |
| AI features (12) | **Cannot be enabled from the UI, fail opaquely, and a guard rejects valid output (T3–T6)** | Below. |
| Skip/Block reminders | **Mostly absent in practice (T7)** | Below. |

### New findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **T1** | P1 | **Slip risk is inverted for old tickets.** `slipRiskFor` uses `max(0, P50 − age)`, so a ticket older than every comparable ticket has "0 days to go" → **LOW**, while a 1-day-old ticket is HIGH. The aging chip ("older than P85") and slip level contradict on the same ticket. Also: lead time comes only from *resolved* tickets (survivorship bias). | Probe: age 45 d, due in 2 d → LOW; age 1 d, due in 5 d → HIGH. Seed `53` red (4). |
| **T2** | P1 | **Severity labels are unreachable.** P1 overdue 6 days **and** blocked = 56 → MEDIUM; P1 due tomorrow = 39 → LOW. The Priorities page filters by Critical/High, so those tabs are nearly empty. | Probe table; seed `55` red (5). |
| **T3** | P1 | **No way to configure the AI provider in the UI.** The only path is `ANTHROPIC_API_KEY` in the server env (redeploy). The UI just says "Server API key configured: yes/no". The client caches availability once per page load. | `data-settings/page.tsx` ~L1668–1690; `claude-provider.ts` `availability`. |
| **T4** | P1 | **AI failures are opaque.** Every failure (bad key 401, model not found 404, refusal, truncation, invalid JSON, provider outage) collapses to `CALL_FAILED` → "AI unavailable" / Mock text. The server's `errorKind` is thrown away; the usage ledger has no provider error kind. A wrong key looks like "AI works, just mock". | `claude-provider.ts` `call()`, `server-runner.ts`. |
| **T5** | P1 | **The grounding guard rejects valid output.** Vietnamese dates (`27/10`, `ngày 27 tháng 10`) of a date that IS in the facts → "number 27 is not in the supplied facts" (the guard strips ISO dates from the facts before collecting fact numbers); `Step 1:` markers; derived counts ("1 blocker"); capitalised phrases (`Go Live`, `Slack Channel`) are flagged as invented people. A rejection costs two model calls and ends in Mock text. Vietnamese features (report rewrite, mention reply) are the most exposed. | Probe of `checkGrounding`; seed `54` red (5). |
| **T6** | P2 | **No repair retry for schema failures.** Only grounding violations retry; a string over a schema `max` (e.g. 1000 chars) → immediate 502 `invalid-output` → Mock. | `server-runner.ts` `callAndValidate`. |
| **T7** | P1 | **Reminders for parked tickets do not work the way you need** (details in §3). Re-check dates are optional; Slack reminders exist only for *blocks with a ping date* and only fire **while a browser tab is open**; skips/defers never reach Slack; no snooze/escalation; tickets parked with no date vanish. | `follow-up-runner.ts`, `ReasonPickers`/`TaskReferenceRow` ("Re-check on (optional)"), `morning-mode.ts`. |

Seeds (red on V2.45): `53-forecast-old-tickets`, `54-grounding-locales`, `55-severity-calibration`.

---

## 2. Requirement 2 & 3 — what "AI works" must mean

Today the chain is: toggle → key in server env → project allow-list → (hidden) model call → schema → grounding → Mock fallback. Any link failing looks the same. Target state:

```
Data & Settings → AI provider
┌──────────────────────────────────────────────────────────────────────┐
│ ● Connected · Anthropic · key …3f9a (saved, encrypted) · verified 2m ago │
│ Provider      [ Anthropic ▾ ]                                          │
│ API key       [ ••••••••••••••••••••••• ]  [Save & test]  [Remove]     │
│ Models        Fast [haiku-5-5 ▾]  Default [sonnet-5-5 ▾]  Deep [opus-5-5 ▾] │
│ Daily budget  [400,000 tokens]  today 38,210 used  ▮▮▯▯▯▯▯▯            │
│ Test          Fast ✓ 410 ms · Default ✓ 880 ms · Deep ✗ model not found │
│ ▸ Advanced: custom base URL (off unless the admin allows it)           │
│ [Run AI self-test: Quick ~8k tokens | Full]   → table per feature      │
│ AI health (7 days): ok 91% · grounding-rejected 6% · invalid 2% …       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Requirement 4 — current reminder capability (verified) vs what you asked

| You need | Today |
|---|---|
| A reminder date **per task** when I skip/block | Optional field "Re-check on (optional)". Nothing prompts for it. |
| Not to forget tickets parked with **no** date | Nothing: a skipped ticket without a date is never surfaced again. |
| A reminder even when the app is closed | Slack reminder is sent by a **browser `setInterval`** (`follow-up-runner.ts`); the cron does not know about it. |
| Reminders for skip and defer, not only block | Only `BLOCKED` + `pingOn` → Slack. Skip/defer: in-app Morning Mode "Due re-checks" only. |
| One concept of "remind me on" | Two: `until` (re-check) and `pingOn` (ping) with different consumers. |
| Snooze / escalate when I ignore it | None. |

---

## 4. Prompts — AI

### D1 — AI provider setup: UI + server-side encrypted key + connection test (V2.46.0)

````text
Read CLAUDE.md first. Plan before coding; show the endpoint/storage design for approval in the plan. Red-first.

GOAL: a user (single-user install or team member) can set up the AI provider in Data & Settings without touching env vars or
redeploying, can see exactly why it does or does not work, and can test it.

CONTEXT (verified)
- Only three server places read process.env.ANTHROPIC_API_KEY: app/api/command-center/ai/route.ts (GET status, POST call),
  app/api/command-center/health/route.ts (aiAvailable). The UI panel is static text (data-settings/page.tsx ~L1668-1690).
- claude-provider.ts caches checkClaudeAvailability() once per ClaudeProvider instance (page load): a key added later is never noticed.
- Team mode already has AES-256-GCM secret-box (auth/secret-box.ts, AAD-bound) for per-member Jira tokens. Single-user mode has
  APP_STATE_SECRET + KV. The SDK (@anthropic-ai/sdk 0.122) has client.models.list() and a baseURL option.
- usage ledger + cap + grounding + fallbacks in server-runner.ts must keep working unchanged.

DESIGN (contract)
1. Storage: KV record per scope — `ai-provider:global` (single-user), `ai-provider:u:<uid>` (member), `ai-provider:org` (admin-managed,
   team mode). Record = { provider:"anthropic", sealedKey, last4, fingerprint (first 8 hex of sha256), savedAt, savedBy?, verifiedAt?,
   lastError?, models?:{fast?,default?,deep?}, dailyTokenCap?, baseUrl? }. The key is sealed with secret-box (AAD = scope id).
   Encryption key: AUTH_ENCRYPTION_KEY / HKDF(NEXTAUTH_SECRET) (existing) or, single-user, HKDF(APP_STATE_SECRET, info "daily-command
   ai-provider v1"). No key material or no KV => canStoreKey=false and the panel says what to set; env mode keeps working.
2. Resolution order per request: member record -> org record -> env ANTHROPIC_API_KEY. Models: record.models > ANTHROPIC_MODEL_* env >
   defaults. Cap: min(record cap, env hard cap). The effective source ("member" | "org" | "env") is reported, never the key.
3. Routes (all same-origin only, no-store):
   GET    /api/command-center/ai/provider        status { configured, source, last4, fingerprint, verifiedAt, lastError, canStoreKey,
                                                  customBaseUrlAllowed, models(effective), cap(effective), models available if known }
   PUT    /api/command-center/ai/provider        { apiKey?, models?, dailyTokenCap?, baseUrl?, scope? } — write-only key
   DELETE /api/command-center/ai/provider        removes the saved key (falls back to org/env)
   POST   /api/command-center/ai/provider/test   validates the key with client.models.list() (no tokens), checks each configured tier
                                                  model id is in that list, then ONE tiny messages call per tier (max_tokens 64; HTTP status
                                                  decides success — stop_reason max_tokens is OK). Returns per tier { ok, ms, kind, message }.
   Auth: team mode = signed-in member (scope org => admin only; 503 when sign-in misconfigured); single-user = paired bearer
   (APP_STATE_SECRET) — never unauthenticated. Rate limits: 10 writes/h, 20 tests/h per principal. Every write/test/delete appends an
   audit entry (who, action, outcome, time — never the key) to a bounded KV list (<= 100).
4. SSRF: baseUrl is honoured only when AI_ALLOW_CUSTOM_BASE_URL=true; https only; no credentials in the URL; reject localhost,
   private/link-local/metadata addresses (literal IPs and names resolving to them is a documented residual risk).
5. Error kinds surfaced to the UI (plain language): invalid-key (401), permission (403), model-not-found (404), rate-limited/credit (429),
   provider-down (5xx), timeout/network, unreadable-stored-key (decrypt failure), kv-unavailable, no-key-material.
6. The key is write-only: never returned, never in any client state, IndexedDB, backup export, log, error message, trace or test snapshot.
   Redact /sk-ant-[A-Za-z0-9_-]+/ from every error string before it leaves the server.

TASKS
1. Pure module ai/provider-config.ts (types, resolution, validation, error-kind mapping) + server store lib/server/ai-provider-store.ts
   + the four routes. Reuse secret-box; extend key derivation for single-user as described.
2. Wire resolution into ai/route.ts (GET status incl. `provider` block; POST uses the resolved key/models/baseURL; Anthropic client cached
   per fingerprint for <= 60 s) and health/route.ts (aiAvailable = resolved key present). resolveAiModel gets the record's models.
3. Client: replace the one-shot availability cache with a 60 s TTL + `refreshAiAvailability()`; call it after save/test/delete; keep
   `checkClaudeAvailability()`'s signature. Surface the server `errorKind` from /ai calls: claude-provider keeps the last N
   {task, errorKind, httpStatus?} (no prompts/inputs) so every "AI unavailable" note can say why (T4). Extend the AiProviderState union.
4. UI: new components/command-center/AiProviderPanel.tsx replacing the static "AI provider" panel (mount only; do not grow page.tsx).
   Per the wireframe in section 2 of the review: status chip, write-only key field + "Save & test", Remove, tier model selects (options from
   the test's models.list result; fall back to a constants list; allow a custom id), budget bar, per-tier test results, advanced base URL
   (hidden unless allowed), "Where is my key stored?" disclosure. After a successful save the key field is cleared and removed from the DOM state.
5. use-ai-readiness / readiness.ts: NEEDS_KEY nextStep becomes "Add your API key in Data & Settings -> AI provider" when canStoreKey,
   else the env instruction. Add states KEY_REJECTED and MODEL_UNAVAILABLE (from the last test/error) with their next steps.
6. Update the 5 tests that grep ANTHROPIC_API_KEY copy; keep their intent. Add tests (new numbered file) for everything below.
7. CLAUDE.md: add "provider secrets are write-only, server-side, never in client state/backups/logs". docs/CONFIG.md: new section.
8. Version 2.46.0.

ACCEPTANCE
Happy path
- [ ] Fresh install (no env key): save a valid key -> status "Connected (saved key …last4)", tier tests pass, an AI feature that was in Mock now calls the model WITHOUT reload (availability refresh).
- [ ] Env key present + saved key: saved key wins; panel says it overrides the server env; Remove falls back to env.
- [ ] Team mode: member key works for that member only; org key (admin) is used by members without their own; usage is still recorded per uid.
Validation
- [ ] Empty/whitespace key, key containing spaces/newlines/control chars, > 300 chars, or wrong prefix -> 400 with a field message; nothing stored.
- [ ] Unknown model id -> test shows "not found for this key" and the setting is NOT marked verified; saving it is still allowed (custom ids) but flagged.
- [ ] dailyTokenCap must be an integer >= 0 and <= the env hard cap; baseUrl rejected unless allowed + https + not private.
Error
- [ ] 401/403/404/429/5xx/timeouts each map to their own plain-language message in the UI and in the route response (table-driven test with a fake SDK).
- [ ] KV down -> 503 "cannot save", no partial write; decrypt failure -> treated as not configured with lastError, never a crash.
- [ ] Unauthenticated / unpaired / non-admin-for-org -> 401/403; misconfigured sign-in -> 503; cross-origin -> 403.
Edge
- [ ] Rotating the key overwrites the old sealed value; two tabs saving concurrently end in a valid record.
- [ ] No encryption material available: panel is read-only with the exact variable to set; env mode unaffected.
- [ ] Rate limit: the 11th write within an hour -> 429.
Security
- [ ] A test serialises every response, trace entry, audit entry, error and log line produced across all scenarios and asserts the key (and its sealed form) never appears.
- [ ] Key never present in backup export (backup.ts), localStorage, IndexedDB blob, or the synced app-state blob (test over the real exporters).
- [ ] Ciphertext copied to another scope does not decrypt (AAD binding test).
````

---

### D2 — AI answer quality: grounding guard v2, schema-repair retry, telemetry (V2.46.0)

````text
Read CLAUDE.md first. Plan before coding. Red-first.

CONTEXT (verified)
- checkGrounding (ai/evaluation.ts) strips ISO dates from the FACTS before collecting fact numbers, then flags the digits of any
  output date written another way. Probe: facts "due 2026-10-27", output "ngày 27/10" or "ngày 27 tháng 10" -> "number 27 is not in the supplied facts".
- "Step 1:" markers, derived counts ("1 blocker"), and capitalised phrases not in the prompt ("Go Live", "Slack Channel") are rejected;
  the last is reported as "person ... is not in the supplied facts".
- server-runner.ts callAndValidate: one retry for grounding violations only; a schema failure (e.g. a string over its max) returns
  502 invalid-output at once. Ledger outcomes exist but do not say WHICH rule fired.

TASKS
1. Place seed 54-grounding-locales.test.mts in scripts/tests/ now (seeds 53 and 55 belong to D5), register it in run.mts, show it RED.
2. Dates: before number collection, parse date-like tokens in BOTH facts and output: ISO, d/m, d/m/yyyy, d-m, "ngày d tháng m (năm y)",
   "tháng m", "Month d", "d Month", "27th of October". Compare month-day (and year when both present); ambiguity d/m vs m/d is accepted if either
   reading matches a fact date. A date-like token is validated as a date and then removed from the number scan. Not-in-facts dates stay rejected.
3. Markers: "Step N", "Bước N", "N)" / "(N)" / "#N" enumeration markers are formatting, not claims.
4. Counts: add a per-task `grounding` policy in task-registry.ts: "strict" (reports/rewrites, locked facts — unchanged) or "counts" (narrative
   tasks). In "counts" a number n <= 12 immediately followed by ticket(s)/item(s)/blocker(s)/comment(s)/mention(s)/question(s) is accepted when
   n <= the number of distinct ticket keys (or listed items) in the prompt; days/hours/%/points/dates stay strict. Document the policy per task.
5. People: flag a capitalised pair only when it is `@Name`, follows by/from/to/cc/assigned to/ask/ping/owner, or is followed by said/replied/
   commented/approved/confirmed/asked/owns. Phrases like "Go Live", "Slack Channel", "Happy Path" are no longer reported as people.
6. Repair retry: on schema failure make ONE repair attempt (append the model's text + a user message listing up to 8 Zod issues as
   path + message, "return the full JSON again, fixing only these"). Total model calls per request stay <= 2 across grounding OR schema repair.
7. Prompt limits: for every task, the REQUIRED OUTPUT SCHEMA section of its prompt lists the max lengths / max array sizes of the output
   schema, generated from the Zod schema (helper `schemaLimitsText`) so prompt and schema cannot drift. Add a test that fails if a task's
   prompt lacks them.
8. Telemetry: extend AiUsageRecord (optional fields, old records load) with `errorKind`, `httpStatus?`, `violationKinds?: ("key"|"date"|"number"|"person")[]`,
   `repaired?: boolean`. Add an endpoint block to GET /ai/usage: per task, last 7 days, counts by outcome + top violation kinds.
9. UI: "AI health" section inside AiProviderPanel (from D1): per-task outcome rates and the top reasons, plain language by violation kind ("dates: 6, numbers: 2, people: 1"), never the model text.
10. Golden table test (new file): >= 60 cases EN + VN (dates, counts, markers, names, invented keys/dates/numbers/people) with expected pass/reject.

ACCEPTANCE
Happy path
- [ ] Seed 54 green (7 checks); every rewrite/reply/follow-up fixture in Vietnamese that mentions a supplied date passes.
- [ ] A verbose-but-valid answer (string 15% over max) is repaired in ONE extra call and accepted.
Validation
- [ ] Invented ticket key, invented date, invented number >= 13, invented "@Name" are all still rejected (golden table).
- [ ] "strict" tasks (report rewrite, release brief numbers) behave exactly as before (existing tests untouched and green).
Error
- [ ] Repair attempt fails again -> 502 invalid-output (no third call); grounding fails twice -> 422 as before; both logged with violationKinds.
- [ ] Token cap is re-checked before the repair call (a request at the cap boundary does not overshoot by more than one call).
Edge
- [ ] d/m vs m/d ambiguity; year present and different; "27 tháng 10" without year; dates inside ticket titles; list markers at line start AND inline.
- [ ] Old ledger records (no new fields) still load and summarise.
````

---

### D3 — AI self-test and live smoke script (V2.46.0)

````text
Read CLAUDE.md first. Depends on D1 (key configured) and D2.

GOAL: prove, with one click or one command, that every AI feature works against the real model for THIS installation.

TASKS
1. Fixtures: scripts/ai-fixtures/ (synthetic, English + Vietnamese variants, NO client data): one representative input per AI task and per
   language-bearing task (mention reply EN/VN, report rewrite VN, follow-ups, Go/No-Go, BA requirement check, triage, weekly insights,
   NBA narration, command parsing, meeting notes). Each fixture carries expectations: language, mustMention (ticket keys), mustNotContain
   (placeholders like [EMAIL_1], "Given/When/Then" for the BA check), max lengths, expected tier.
2. Pure orchestrator ai/selftest.ts: runs fixtures sequentially through handleAiRequest with an injected callModel, collects per task:
   { task, model, tier, ms, inputTokens, outputTokens, outcome, schemaOk, groundingOk, repaired, retried, rubric: [{name, pass, detail}], estCostUsd }.
   Rubric: language matches (Vietnamese detected by diacritic ratio), no placeholder leak, required keys present, length limits, BA check is a
   checklist, tier model used. Stops when the run token ceiling (AI_SELFTEST_MAX_TOKENS, default 60,000) is reached and says so.
   Cost = tokens x a constants table with `verifiedOn` date, labelled "estimate"; verify the prices against Anthropic's pricing page and
   record the date in the constant.
3. scripts/ai-smoke.mts + `npm run smoke:ai`: uses the real Anthropic caller with ANTHROPIC_API_KEY (or the saved key via the same resolver
   when run in the app environment); prints a table, writes ./ai-smoke-report.json (gitignored), exit 1 on any FAIL. Not part of `npm test`/CI.
4. Route POST /api/command-center/ai/selftest (same auth as D1; 3 runs/day/principal; refuses when the daily cap would be exceeded; bypasses
   the dedupe cache; records ledger entries with `selftest: true`; modes "quick" (5 core tasks) and "full").
5. UI: "Run AI self-test" in AiProviderPanel: shows estimated tokens, requires a confirm click, renders the table (row per feature with a
   plain verdict and the first failing rubric item), "Copy report". A failing row links to the relevant fix (key, model, allow-list, guard).
6. Offline tests for the orchestrator with a fake model that returns: perfect output, over-long output, ungrounded output, English for a
   Vietnamese task, a leaked placeholder, truncated text, refusal — each must produce the right rubric verdict.
7. Version bump with D1/D2 (2.46.0).

ACCEPTANCE
Happy path
- [ ] With a valid key, "quick" completes under its token estimate and every core task is PASS or WARN with a reason.
- [ ] `npm run smoke:ai` prints the same table and JSON.
Validation
- [ ] Without a configured key the route answers 409 "configure a key first"; with the daily cap nearly used it refuses before any call.
Error
- [ ] A task that fails does not stop the run; its row shows outcome + errorKind; the process exit code is 1 only for the script.
- [ ] Ceiling reached -> remaining tasks reported as SKIPPED (not PASS).
Edge
- [ ] Re-running within a minute does not hit the dedupe cache; the ledger separates selftest usage from real usage in the cap display.
- [ ] No fixture contains real names/emails/keys (test greps fixtures for @-addresses and sk- prefixes).
````

---

## 5. Prompts — correctness & reminders

### D4 — Reminder Center: never forget a skipped / blocked / deferred ticket (V2.47.0)

````text
Read CLAUDE.md first. Plan before coding; show the data-model and cron design for approval. Red-first. Backward compatible: existing
`until`, `pingOn`, `followUpNotified`, FOLLOW_UP Slack payloads and Morning Mode "Due re-checks" keep working.

GOAL: every SKIPPED / BLOCKED / DEFERRED ticket carries a reminder date chosen per task; the user is reminded on that date even when the
app is closed; ignored reminders escalate; nothing parked without a date can vanish.

CONTEXT (verified)
- TicketWorkState has `until` (re-check/wake-up) and, for BLOCKED, `pingOn`. dueRechecks() (morning-mode.ts) reads `until`; follow-up-reminders.ts
  reads `pingOn`; Slack reminders are sent by a browser setInterval (follow-up-runner.ts) and tracked in client state `followUpNotified`.
- The re-check date field is labelled "Re-check on (optional)" (TaskReferenceRow). Skip/Defer never reach Slack. No snooze, no escalation.
- ticketWorkStates is already part of the synced app-state blob, but the cron only reads its own small KV records.
- The cron (jira/sync GET -> cron-tick) already has: delivery guarantees + retry (cron-notify), per-member plans, heartbeat, quiet hours/prefs (P3.5).

DESIGN (contract)
1. One concept: `remindOn` (local YYYY-MM-DD) for BLOCKED/SKIPPED/DEFERRED. Canonical storage stays `until`; `remindOn` is its
   alias; for BLOCKED, remindOn = pingOn ?? until (migration: if both exist keep both, remindOn = the earlier). New optional fields on the
   record: reminder { snoozedUntil?, level (0..3), lastRemindedOn?, noReminder?: true, setAt }. Old blobs load unchanged.
2. Capture (Skip / Block / Defer dialogs everywhere TaskRow is used, Focus Session, Morning Mode keys, Command Bar NL commands, AI triage apply):
   a "Remind me" row with chips [Tomorrow] [In 3 days] [Next Monday] [In 2 weeks] [Custom date (+ optional time)] and a smart default:
   BLOCKED -> blocker SLA in business days, or 2 business days before the Jira due date when sooner; SKIPPED -> +3 business days;
   DEFERRED -> the chosen date. The chosen date is REQUIRED unless the user clicks "No reminder (I'll find it myself)" which stores
   noReminder:true. Setting `requireReminderDate` (default ON for new installs; existing installs keep OFF until they opt in; both explained in Settings).
3. Lifecycle: SCHEDULED -> DUE (on/after remindOn at deliveryHourLocal, default 09:00 in the user's zone; weekends moved to Monday when
   skipWeekends) -> SNOOZED(until) -> RESOLVED (ticket leaves the state, or is Done in Jira) ; ESCALATED when ignored: re-remind at +1, +3, +7
   days (configurable ladder), then a weekly "stale parking lot" line. Each escalation changes wording/salience, never spams more than once per day.
4. Parked-without-date guard: a ticket with noReminder (or a legacy skip/block with no date) older than `parkedWithoutDateDays` (default 14)
   appears in the Reminder Center under "Parked without a date" and in the weekly digest line.
5. Activity-triggered early reminder ("unblock signal"): for BLOCKED tickets, when Jira shows new activity since parking (comment, status
   change, assignee change) notify immediately: "WF-12 had activity: <author> commented …" (one batched `key in (...) AND updated >= <lastCheck>`
   query, then newest-comment fetch for the hits only, <= 10 per run, bounded concurrency).
6. Server-side delivery: the client mirrors a compact ReminderIndex to KV (`reminders` record scoped like notify-state: global or per member)
   — items { ticketKey, status, remindOn, reason?, snoozedUntil?, level, lastRemindedOn?, projectKey, title } (no description/comment text),
   debounced on every status/reminder change, authenticated like the notify prefs route. The cron `runRemindersTick`: due items (user zone,
   deliveryHour..+2 cadences, not snoozed, not already sent for (ticketKey, remindOn, level)) -> ONE batched Jira check (`key in (...)`, chunks of
   50) that drops tickets already Done / unassigned from me -> one grouped Slack message ("3 reminders due today": ticket, state, reason, age,
   link) -> record lastRemindedOn/level. Use the C1 delivery-guarantee machinery (owed signals, bounded attempts, flood guard) and the P3.5
   quiet hours. When server reminders are active the browser runner stops sending (no duplicates) — same pattern as serverSideNotifyActive.
7. Reminder Center page `/reminders` (+ Nav item with a count badge, header chip count, Morning Mode step uses the same list, NBA already
   consumes dueRecheckKeys): tabs Due now | Upcoming | Parked without a date | Snoozed | History. Row = TaskRow + inline: Reactivate /
   Unblock / Done / Snooze (1 day, 3 days, next Monday, custom) / Change date (+reason) / Draft ping (existing blocker follow-up drafter) /
   Open in Jira / Stop reminding. Bulk select + bulk snooze/reactivate. Filter by project and state. Empty state explains the feature.
   Add the route to the page smoke test.
8. Settings (Data & Settings -> Reminders, new component, mount only): requireReminderDate, deliveryHourLocal, skipWeekends, escalation
   ladder, parkedWithoutDateDays, channels (in-app always; Slack when configured), "Send me a test reminder".

TASKS
1. Pure modules: reminder-model.ts (types, migration/alias rules, validation), reminder-schedule.ts (business-day math, weekend shift, tz,
   deliveryHour window, escalation ladder, snooze), reminder-index.ts (build/mirror/diff), reminder-digest.ts (grouping + Slack text).
2. Store wiring through setTicketStatus and the existing wrappers (no second write path); migration on parse; sync merge (LWW per ticket).
3. Capture UI (shared `ReminderPicker.tsx` used by every dialog) + `requireReminderDate` enforcement + Morning Mode keys (S/B/F open the picker
   with the smart default pre-selected; Enter accepts it, so keyboard triage stays fast).
4. KV store + route for the index (lib/server/reminder-index-store.ts, POST/GET /api/command-center/reminders/index) and cron tick integration
   (cron-tick.ts, member plans, heartbeat counters: remindersSent, remindersDue, remindersDropped).
5. /reminders page, Nav badge, header chip, Morning Mode step reuse, Settings panel, "Send test reminder".
6. Tests (new numbered file(s)) as listed below; README/docs section; version 2.47.0 (with D5).

ACCEPTANCE
Happy path
- [ ] Skip with "In 3 days": record has remindOn = +3 business days; on that day at 09:00 local the cron sends ONE grouped Slack message and the Reminder Center shows it under Due now — with the browser closed.
- [ ] Block with the default: remindOn from the SLA / due-date rule; "Unblock" on the reminder row unblocks through setTicketStatus and clears the reminder.
- [ ] Defer to a date: the existing wake-up behaviour is unchanged AND a reminder is sent that day.
- [ ] Snooze to Monday: nothing is sent before Monday; escalation counter resumes correctly.
Validation
- [ ] With requireReminderDate ON, Skip/Block/Defer cannot be confirmed without a date or "No reminder"; a past date is rejected; invalid dates are rejected.
- [ ] Time of day (optional) accepts HH:mm only; deliveryHourLocal 0-23.
- [ ] Legacy records (until/pingOn only) show the right remindOn in the UI without any migration prompt.
Error
- [ ] Slack down on the due day: the reminder stays owed and is delivered once Slack is back (exactly once; attempts bounded as in C1).
- [ ] Jira unreachable during the pre-send check: send anyway (do not lose a reminder), mark `unverified`, re-check next run.
- [ ] KV unavailable: client keeps working locally; the index is retried; Setup Health says server reminders are inactive and why.
- [ ] Ticket Done in Jira before the due day: no message; reminder resolved; History shows "closed in Jira".
Edge
- [ ] remindOn on Saturday with skipWeekends -> Monday; DST/timezone boundaries (user zone from the P-series IANA resolver); remindOn today but after delivery window start.
- [ ] 60 parked tickets due on one day -> grouped message with "+N more" (flood guard), drained over later runs, never duplicated.
- [ ] noReminder ticket older than 14 days appears in Parked-without-a-date and once in the weekly line, not daily.
- [ ] Two devices change the same ticket's reminder: last-write-wins merge, index reflects the winner.
- [ ] Reminder escalation levels never send more than one message per ticket per day; escalation stops when the ticket leaves the state.
- [ ] Team mode: indexes and prefs are per member; a member without Slack still gets in-app reminders.
- [ ] Browser runner and cron never both send (test with server reminders active/inactive).
````

---

### D5 — Forecast & severity correctness (V2.47.0)

````text
Read CLAUDE.md first. Plan before coding. Red-first.

CONTEXT (verified; seeds 53 and 55 are red on V2.45)
- T1: forecast/slip-risk.ts uses expectedRemaining = max(0, P50 - age). Any ticket older than P50 has "0 left"; older than P85 -> LOW.
  Probe (12 resolved tickets, 2..13 days): age 45d due in 2d -> LOW; age 1d due in 5d -> HIGH. forecast/aging.ts flags the same 45d ticket as
  "older than P85", so the two chips contradict.
- T2: scoring v2 totals rarely exceed ~56 for a realistic ticket; classify() thresholds 80/60/40 are unreachable. P1 overdue 6d + blocked = 56
  (MEDIUM); P1 due tomorrow = 39 (LOW). The Priorities page filters by Critical/High.

TASKS
1. Place seeds 53-forecast-old-tickets and 55-severity-calibration in scripts/tests/ (register in run.mts), show them RED.
2. Forecast (T1): remaining time must be CONDITIONAL on survival: among comparable resolved tickets with days > age, remaining = days - age;
   P50/P85 of those when n_conditional >= 5. Otherwise: if age > P95 of all comparable tickets -> "no precedent": level HIGH when overdue or
   due within 7 days, else MEDIUM, with explanation "older than every comparable ticket (n = …)"; if age <= P95 but n_conditional < 5 -> MEDIUM
   "thin precedent". Never LOW without precedent. Expose `precedent: "conditional" | "thin" | "none"`. Show "k open peers are older than this"
   as context. Document the right-censoring limitation (lead time uses only resolved tickets) in the code and README, and prefer cycle
   time from statusCategoryChangedAt for In-Progress tickets when available (keep lead time as the fallback).
   The aging chip and the slip level must come from one function so they cannot contradict.
3. Severity (T2): keep the numeric score and v1 untouched. Add `classifyV2(score, facts)` used by v2 surfaces: (a) hard-rule floors — P1/P2
   overdue >= HIGH; P1 overdue AND blocked >= CRITICAL; P1 due within 1 day >= MEDIUM; blocked P1/P2 >= MEDIUM; awaiting-me past SLA on P1/P2 >= HIGH;
   (b) thresholds recalibrated to the score range v2 can actually produce (derive from the factor maxima; document the table) rather than 80/60/40.
   Snapshots/trends keep comparing SCORES (no discontinuity); record `severityRules: "v2.1"` so classification changes are explainable.
   Show the reason for a floor in reasoning/Why-this-score ("CRITICAL: P1, overdue 6 days, blocked").
4. Data & Settings -> Scoring: a small read-only distribution (counts per class now) so the user can see the effect; no threshold sliders yet.
5. Version 2.47.0 (with D4).

ACCEPTANCE
Happy path
- [ ] Seeds 53 and 55 green (every check was red before; paste before/after).
- [ ] The Priorities Critical/High tabs are populated on the demo dataset and on a Jira-like fixture; a fresh P4 stays LOW.
Validation
- [ ] Table-driven slip tests: young/typical/old/older-than-P95/no dueDate/overdue/thin history/UNKNOWN estimate (no output when n < minimum).
- [ ] Monotonic: for equal facts, higher priority never yields a lower class; more overdue days never lower.
Error
- [ ] Missing createdDate/resolvedAt, negative or NaN day counts -> no forecast (null), never a throw or a default LOW.
Edge
- [ ] age exactly P50 / P85 / P95; n_conditional exactly 4 and 5; due today; floors combine without exceeding CRITICAL; v1 model results byte-identical to before.
- [ ] Release Health, Weekly Review and NBA that consume classification use the new function consistently (grep proves no caller still reads the raw 80/60/40 on v2 data).
````

---

## 6. Proposals to make the tool smarter and "wow" (requirement 5)

Ranked by value for a BA/PO running several client projects, feasibility on the current architecture, and commercial leverage.

| # | Feature | Why it wows | Effort | Builds on |
|---|---|---|---|---|
| W1 | **Morning Briefing push** — 08:30 Slack (and in-app) message: due reminders, top-3 Next Best Actions, assigned items due ≤ 2 days, mentions awaiting you past SLA, new HIGH slip risks, one-line AI take (≤ 1 call/day, capped) | The tool comes to you; replaces opening 5 pages | M | D4 index, cron, NBA, forecast |
| W2 | **Sprint Readiness Radar** — Definition-of-Ready score per ticket for the next sprint (description, AC present, estimate, owner, design link, no open blockers) + "what's missing" + one-click AI AC suggestions (only on click, allow-listed) | Core BA/PO value; nobody else shows it next to delivery risk | M-L | BA requirement check, conversation state, sprint field |
| W3 | **Blast Radius & critical path** — "if WF-12 slips 3 days: 4 tickets, 2 projects, Release 2.4 at risk" + small interactive graph | Turns links into a decision tool; great demo | M | dependencies/issue links, forecast |
| W4 | **Ask My Work agent** — multi-turn, tool-using chat over your own data (search, blocked, mentions, forecast, reminders), answers with clickable ticket keys, proposes (never executes) actions via preview | The "ChatGPT for my delivery" experience, grounded | L | D1–D3 proven live first |
| W5 | **PWA + Web Push** — installable app; reminders/briefing as push when the tab is closed, no Slack needed | Mobile presence; removes the Slack dependency for customers | M | D4, W1 |
| — | Meeting prep pack ("since last time" diff per project + open decisions + asks), calendar-aware time budget, Jira ticket creation from captured notes, team pulse for PMs, email digest channel | Good, but later | — | after W1–W3 |

Not recommended now: more AI task types (the existing 12 are not yet proven live), a second AI provider (add after D1–D3; the `provider` field in D1 is the seam), threshold sliders.

### W1 — Morning Briefing (V2.48.0)

````text
Read CLAUDE.md first. Depends on D4 (reminder index), P3.5 (prefs/quiet hours), C1 (delivery guarantees).

GOAL: one proactive message per workday that tells the user what matters, delivered even when the app is closed.

DESIGN
- Content (deterministic first): 1) reminders due today and overdue (D4 index); 2) top 3 Next Best Actions; 3) assigned open tickets due within
  2 days or overdue (live JQL, bounded); 4) mentions awaiting reply past the reply SLA; 5) new HIGH slip risks since yesterday; 6) one
  "heads-up" sentence. Each line has a ticket link. Max ~15 lines; overflow becomes "+N more in the app".
- Data the cron lacks (NBA ranks, slip risks, awaiting-me) is mirrored by the client as a compact BriefingSnapshot in KV (ticket keys + short
  reasons only, no text from tickets), debounced like the reminder index; the briefing says "based on your last session <time>" when the
  snapshot is older than 12 h. Live parts are queried by the cron.
- Optional AI narration: reuse generateDailyGuidance (fast tier), at most one call per user per day, cached by facts hash, only when AI is
  configured, the flag is on and the cap allows; otherwise the deterministic sentence.
- Schedule: briefingHourLocal (default 08:30), skip weekends, quiet hours respected, one briefing per local day (idempotent), delivery
  guarantee as C1. In-app: the same content as the top card of the Command Center and Morning Mode step 1. Setting + "Send me a test briefing".

ACCEPTANCE
Happy path
- [ ] At 08:30 local on a workday exactly one Slack message is sent with the sections above; the in-app card matches it.
Validation
- [ ] Empty days send a short "nothing needs you today" line (setting: skipIfEmpty); weekend/holiday list skips; invalid hour rejected.
Error
- [ ] Slack down -> owed and delivered later the same day, never twice; Jira down -> sections 3-4 omitted with a note, rest still sent; AI capped -> deterministic line.
Edge
- [ ] Two cron runs inside the window do not double-send; DST change day; member without Slack gets only the in-app card; stale snapshot labelled; > 15 lines truncated with "+N more".
````

### W2 — Sprint Readiness Radar (V2.48.0)

````text
Read CLAUDE.md first. Plan before coding.

GOAL: show, for the tickets entering the next sprint, whether each is ready to build — and what is missing — before planning day.

DESIGN
- Scope: tickets in statuses/sprint configured in Data & Settings (reuse the sprint custom field id from B4; default: next sprint + status
  names matched by a editable list such as "Ready for Dev", "Backlog Refinement"), bounded to <= 100 tickets per refresh.
- Definition of Ready (deterministic checklist, per ticket, each item PASS/FAIL/UNKNOWN with evidence): description length >= N; an Acceptance
  Criteria section or checklist present (heading match EN/VN or a checklist block); estimate present (story points field id configurable);
  assignee/owner; a design/spec link (Figma/Confluence/URL pattern list); no unresolved blocking links; labels/components set; no open
  question markers ("TBD", "?", "to be confirmed") in the first 2,000 characters. Description/links are fetched on demand per ticket
  (existing issue-context path), cached by (key, updated), concurrency-limited, respecting the AI allow-list ONLY when sent to AI.
- Score = share of PASS among known items; sprint readiness % = tickets >= threshold; list of top gaps by frequency ("12 tickets lack AC").
- AI (only on click, allow-listed projects, uses the existing baRequirementCheck task and its checklist-not-Given/When/Then rule): "Suggest AC"
  and "Clarification questions" per ticket; bulk "Check top 5 gaps" with a token estimate and confirm. Results are stored per (key, updated).
- UI: new section on the Command Center/Executive view + a `/readiness` page: sprint header with readiness %, table (ticket, score, missing
  chips), filters by project/assignee, CSV export (UTF-8 BOM, CRLF, formulas neutralised — reuse the requirement-check CSV helper), "Copy
  Markdown for the planning meeting". Feeds NBA ("5 tickets for Monday's planning are not ready").

ACCEPTANCE
Happy path
- [ ] A ticket with description, AC checklist, estimate, owner, design link scores 100%; each missing item lowers it and is named.
Validation
- [ ] Unknown estimate field id -> estimate item UNKNOWN (not FAIL) with a Setup hint; EN and VN AC headings both detected; empty description FAIL.
Error
- [ ] Jira fetch failure for one ticket -> that row UNKNOWN with retry; the table still renders; no AI call without a click and an allow-listed project.
Edge
- [ ] 100-ticket cap; cache invalidates on `updated`; description as ADF with nested lists/checkboxes; CSV opens in Excel with correct Vietnamese characters.
````

### W3 — Blast Radius & critical path (V2.48.0)

````text
Read CLAUDE.md first. Inspect jira/normalize.ts (issuelinks -> dependencies) before designing; if link direction/type is not kept, extend the
normalised dependency record additively.

GOAL: "if this slips, what else slips?" — computed, explained, and visible where decisions are made.

DESIGN
- Pure module blast-radius.ts: directed graph from issue links (blocks / is blocked by / depends on / relates only as weak edge, configurable
  link-type map), plus fixVersion membership. For a ticket and a slip of N days (default: forecast P85 - P50, or 3): downstream tickets, projects,
  releases whose target date (max dueDate among members) would be exceeded, and the longest dependency chain (critical path) with slack per node.
  Cycle-safe; depth cap 6; <= 500 nodes per query. Output labelled CALCULATED (+ FORECAST when N comes from the forecast).
- UI: chip on TaskRow/PriorityCard ("blocks 4 · 2 projects"); Risks and Dependencies pages get "Impact" drawer with a compact SVG graph
  (no heavy library; keyboard accessible; click opens the ticket); NBA ranks "unblock X" higher by blast radius; Release Health shows the
  critical path to the release.

ACCEPTANCE
Happy path
- [ ] A -> B -> C chain: slipping A by 3 days reports B and C, the release they belong to, and the chain with per-node slack.
Validation
- [ ] Only configured link types create edges; self-links and duplicate links ignored; Done tickets are not downstream-at-risk.
Error
- [ ] Missing link data -> "no link data synced for this ticket" (UNKNOWN), never an empty claim of "no impact".
Edge
- [ ] Cycles, diamonds, 500-node cap, links to tickets outside the synced scope (shown as "external"), performance within perfBudget on the 3,000-item fixture.
````

### W4 / W5 — later (summary only)

- **W4 Ask My Work agent:** extend the AI route with a stepwise tool protocol (server returns `tool_calls` or `answer`; the browser executes read-only selectors locally under the allow-list and redaction rules; ≤ 5 steps; token-capped; answers must pass the grounding guard; mutations only as previews through the existing store operations). Start only when D3's self-test is green on the real model.
- **W5 PWA + Web Push:** manifest + service worker, VAPID keys in env, subscription records in KV (per member), push for D4 reminders and the W1 briefing, quiet hours respected, graceful fallback to Slack/in-app.

---

## 7. PO runbook for this round (≈ 45 min after D1–D3 ship)

1. Deploy V2.46. Open **Data & Settings → AI provider**, paste your Anthropic key, **Save & test**. Expect three green tiers. If a tier is red, the message names the cause (key, model id, quota).
2. Press **Run AI self-test → Quick**. Paste me the table: it tells us which of the 12 features pass on the real model and which fail the guard.
3. Turn on **Recommended** AI preset (readiness panel), open one Ticket Brief on an allow-listed project, and one Vietnamese report rewrite containing a date — it must not fall back to Mock.
4. After D4: skip one ticket "In 3 days", block one with the default, close the browser; verify the Slack digest arrives at 09:00 local on the due day and the Reminder Center shows the same items.
5. After D5: open Priorities → the Critical/High tabs must show your genuinely urgent items.

## 8. Commercialization notes

D1 is the foundation for bring-your-own-key tenants (per-scope sealed keys, org key for admins, per-member caps, an audit trail) and D3's report doubles as a customer-facing "is my AI set up correctly" diagnostic. D4's server-side index and W1/W5 reduce the dependency on a single Slack workspace. Keep Phase 4 (Jira OAuth 3LO, tenant-scoped durable storage, Auth.js v5, Slack app with buttons) as the next block once D1–D5 are live.
