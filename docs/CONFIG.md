# Configuration reference

Moved verbatim from README.md in V2.45.0 (C3). Environment variables, setup for Jira / Claude / Slack / server-side notify / cross-device sync, and Vercel configuration. The README keeps a short index.

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
| `JIRA_TIMEZONE` (V2.44.1) | Your Jira user's IANA zone, e.g. `America/New_York`. DST-aware, so it wins over `JIRA_TIMEZONE_OFFSET_MINUTES`. Optional: when unset the server learns the zone from Jira (`/myself`) and re-checks it weekly. |
| `JIRA_TIMEZONE_OFFSET_MINUTES` | Tightens the incremental-sync cursor to minute precision for your Jira instance's configured timezone (e.g. `420` for UTC+7 / Vietnam). | Falls back to a day-level cursor — still correct, just re-fetches a bit more per sync. |
| `JIRA_PROJECT_KEYS` | Comma-separated list to scope sync to specific projects (e.g. `JPMC,UBS`). | Syncs all discoverable projects. |
| `JIRA_PROJECT_CLIENT_MAP` | JSON object mapping a Jira project key to a display client name (e.g. `{"JPMC":"J.P. Morgan"}`), for "one client, many projects". | Project name is used as the client name. |
| `CRON_SECRET` (V2.10, fixed V2.15) | Requires `Authorization: Bearer <value>` on every request to `/api/command-center/jira/sync`, for the scheduled sync in `vercel.json` / `.github/workflows/sync.yml`. | The sync route stays exactly as open as it always was — no auth check. **V2.15 fix:** configuring `CRON_SECRET` alone used to disable the in-app "Sync Now" button (a browser can never safely hold `CRON_SECRET`). The route now also accepts `Authorization: Bearer <APP_STATE_SECRET>` (see Cross-Device Sync below) — pair this device once in Data & Settings and Sync Now works again even with `CRON_SECRET` locked down. Without pairing, the button now fails with a specific "pair this device" message instead of a bare 401. |

A malformed value for any optional variable is ignored (never throws) and falls back to the safe default above.

**Jira write-back (V2.35, server gate — all three required to write anything):**

| Variable | Purpose | Behavior when missing |
| --- | --- | --- |
| `JIRA_WRITE_ENABLED` | Must be exactly `true` for `/api/command-center/jira/write` to send anything to Jira. | Default **false**: every write and transition lookup answers 503, whatever the in-app switch says. Setup Health names the missing variable when the in-app switch is on. |
| `JIRA_WRITE_PROJECT_KEYS` | Comma list of project keys the server may write to (e.g. `PAY,OPS`). Required when enabled. | 503. An issue outside the list → 403, nothing sent to Jira. |
| `JIRA_WRITE_SECRET` | Its own secret for writes (generate like the others, e.g. `openssl rand -hex 32`). Each device that may write pastes it once in Data & Settings → Jira write-back (stored only in that device's localStorage, like the sync pairing). Writes need `Authorization: Bearer <JIRA_WRITE_SECRET>` (constant-time check). `CRON_SECRET` and `APP_STATE_SECRET` are never accepted for a write (401); reading a ticket's available transitions also accepts the sync pairing. | 503. |

Writes are limited to 30 per hour per server instance (429 beyond), and every write past authentication — ok, failed, refused for the project, rate-limited — is appended to a server log in Vercel KV (time, issue key, action, outcome; at most 200 characters of comment text), shown in Data & Settings → Jira write-back.

**Server report snapshot timing (V2.35):** the Vercel cron in `vercel.json` runs at `0 11 * * *` — 11:00 UTC, i.e. 18:00 in UTC+7 — so the day's server snapshot (see "Reports without opening the app") is taken after the workday and includes afternoon Jira closes. For another timezone, set the hour so it lands at or after 17:00 local: local hour − UTC offset (e.g. `0 22 * * *` for 17:00 in UTC−5); Setup Health warns, using `JIRA_TIMEZONE_OFFSET_MINUTES`, when the scheduled run falls before 17:00 local. `REPORT_SNAPSHOT_HOUR_LOCAL` (0–23, default `17`) is the local hour from which a cron run may write the day's snapshot — an earlier run still notifies but writes nothing, so adding a second, morning cron for the Morning Brief (e.g. `0 0 * * *` = 07:00 UTC+7, if your Vercel plan allows two crons) can never freeze a day that isn't over. This repo keeps one cron.

### Claude / Anthropic (optional — enables real AI wording instead of Mock)

| Variable | Behavior when missing |
| --- | --- |
| `ANTHROPIC_API_KEY` | Every AI-labeled output (risk explanations, communication drafts, artifact wording, weekly review narrative, etc.) runs through the deterministic **Mock AI** provider instead — same schemas, same trust labeling, clearly marked "Mock fallback" everywhere it appears. No external call is made, no data leaves the browser. |
| `ANTHROPIC_MODEL` (C4, V2.36) | Default tier (priorities, risks, decision options, artifacts, Ask…) uses the mid-cost default `claude-sonnet-5-5`. Setup Health notes that the model isn't pinned. |
| `ANTHROPIC_MODEL_DEEP` (V2.36) | Deep tier — only tasks explicitly marked deep (requirement check; a release brief when added) — uses the default `claude-opus-5-5`. |
| `AI_DAILY_TOKEN_CAP` (V2.36) | Server-side daily AI budget in tokens (input + output + cache reads/writes, UTC day); default `400000`, `0` turns AI calls off. When reached the AI route answers 429 and every AI feature shows its deterministic text. Usage is logged in Vercel KV when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are set (shared by all instances), otherwise per server instance (Setup Health then warns "AI daily cap is per server instance — configure KV to enforce it"); Data & Settings shows today/7-day totals. |
| `AI_ALLOWED_PROJECT_KEYS` (V2.39) | Server AI data policy: comma list of Jira project keys whose ticket content `GET /api/command-center/jira/issue-context` will return. Any other project → 403 before Jira is called. The personal allow-list (Data & Settings → AI data protection) still applies on top, so AI works only for projects in both; Data & Settings shows this list read-only to a paired device. Unset = no server restriction. A value with no valid key allows nothing. |
| `ANTHROPIC_MODEL_FAST` (C4) | Short narration tasks (explain changes, trend/outcome interpretation, end-of-day summary, daily guidance) use the cheaper default `claude-haiku-5-5` (V2.44; was `claude-haiku-4-5`, now a legacy model — set `ANTHROPIC_MODEL_FAST` to keep it). |

Read server-only inside `src/app/api/command-center/ai/route.ts`; the browser only ever POSTs `{ task, input }` (the server builds the prompt) and receives back schema-validated JSON — it never talks to Anthropic directly and never sees the key.

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
| `PERSONAL_JIRA_ACCOUNT_ID` | Server-only, separate from the browser-stored `PersonalIdentity.accountId` (a cron invocation has no browser session to read that from) — the Jira `accountId` the server-side check tracks assignments/mentions for. | The cron has nothing to do and makes no Jira call (V2.39 — it no longer runs the full sync either; see Review fixes (V2.39)). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (V2.42) | A Redis/KV store: auto-injected by Vercel's KV integration, or by a Redis (Upstash) integration from the Marketplace. The first complete pair wins (`KV_*` first, so existing deployments are unaffected); a half-set pair is ignored. Used through `@upstash/redis` in `src/lib/server/kv-client.ts` only. | Same as above — a complete no-op; `notify-store.ts`'s `get()` returns `null` and `set()` does nothing, never an error. |

Both are required together for the server-side path to activate; either one missing means an install behaves byte-for-byte like it did before this pass (Option A/client-only). Data & Settings' "Slack Notifications" panel and `GET /api/command-center/notify` both report the live `serverSideNotifyActive` boolean so you can confirm which mode is actually active.

**Honesty about what this does and doesn't do:** this makes real-time notify genuinely real-time-and-unattended **once configured** — it does not make the app "always real-time regardless of setup." An install that never sets up `PERSONAL_JIRA_ACCOUNT_ID` + Vercel KV behaves exactly as it did in V2.10/V2.12: notifications only fire while a browser tab is open. Once both server-side and client-side notify are active, the client detects this (`serverSideNotifyActive: true`) and defers entirely to the server path — it still computes everything for its own UI (lifecycle badges, etc.), it just skips its own Slack POST, so a mention/assignment is never double-sent by two independent tracking systems (server KV vs. browser localStorage).

The very first cron run after this is configured for an install that already has real assigned/mentioned tickets sitting in Jira establishes a baseline and sends **zero** Slack messages — the exact same cold-start discipline V2.10.1 already guarantees for the browser-tab path, now also true for the unattended one. A cron run's own connectivity failure (Jira unreachable, credentials rejected, etc.) never corrupts the persisted baseline — the next successful run still diffs correctly against the last known-good state.

**KV client (V2.42):** `@vercel/kv` (deprecated, a thin wrapper over Upstash Redis) was replaced by `@upstash/redis` behind the single `src/lib/server/kv-client.ts` seam. Key names, value shapes, TTLs and the "unconfigured = silent no-op" behaviour are unchanged, and the old `KV_REST_API_*` variable names keep working; a Redis integration's `UPSTASH_REDIS_REST_*` names work too.

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
- Server has no state yet → this device's local state becomes the baseline (protects an existing pre-V2.15 install's real local data — see the dedicated migration-safety test in `scripts/tests/`).
- Local looks never-meaningfully-used (no attention lifecycle activity, no decisions, no planning activity) → adopt the server's copy wholesale.
- Both sides have real content and the server is newer → merge: record collections (decisions, actions, personal-plan items, memory events) union by id so a locally-added-but-not-yet-synced record is never dropped, even though the single-timestamp blob design (§ below) means simple preference blocks resolve to "whichever whole side is newer," not true per-field freshness.
- Otherwise (this device is already at least as fresh as the server knows) → push local forward.

Every mutation to a synced field debounces a single `POST` a few seconds later (rapid edits coalesce into one KV write); a failed `POST` (offline) is retried with exponential backoff and retried immediately on the browser's `online` event — the pending write is never lost in the meantime, since it's already sitting in the same `localStorage`-persisted local state every other mutation already uses.

**Honesty about the merge model:** the server blob carries exactly one `updatedAtIso`, not one per field — so "per-field where reasonable" (Task 3's own escape hatch) means id-level union for record collections, and "whichever whole side is newer" for scalar preference blocks (UI toggles, identity). True concurrent field-level editing is rare for a single-user tool; this is the documented, honest boundary of that design rather than a fabricated finer-grained merge.

### Configuring in Vercel

Project Settings → Environment Variables → add the ones you need for the **Production** (and optionally **Preview**) environment, then redeploy. Never commit real values to the repo — `.env*.local` is already git-ignored.
