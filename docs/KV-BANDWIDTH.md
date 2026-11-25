# KV (Upstash) bandwidth budget

Upstash's free plan caps **bandwidth at 10 GB/month**; commands (500k) and storage (250 MB) are far from the limit
(observed 2026-11-25: 11K commands, 66 MB, **10 GB / 10 GB**). When the cap is hit EVERY KV call fails — including the
sign-in access check (`smembers invites`), so nobody can sign in. This file is the working budget for cutting bytes.

Legend: **ESTIMATE** = from code reading and the size caps in the source; **MEASURED** = from `KV_METRICS=1` logs
(see "How to measure"). Nothing in this table is measured yet.

## How to measure

```bash
KV_METRICS=1 npm run dev > kv.log 2>&1        # or copy Vercel function logs (lines starting "[kv-metrics] ")
npx tsx scripts/kv-metrics-report.mts kv.log  # per key family: calls, bytes read/written, avg/max, % of total
```

`KV_METRICS` unset (the default) = the unwrapped client: zero overhead, zero behaviour change. A log line carries the
op, the key with the user id hashed, bytes in/out, ms and an optional caller tag — never a value.

## Size assumptions (ESTIMATE, from the caps in the source)

| Blob | Cap in source | Assumed typical size |
|---|---|---|
| `server-reports:v1` (one blob, up to 60 days of daily standups + baseline with ≤2000 seen-mention ids) | `MAX_SERVER_REPORT_DAYS = 60`, `MAX_SEEN_MENTIONS = 2000` | 300 KB – 1 MB (each day lists every open assigned ticket) |
| `app-state:v1` (decisions, action plan, ≤200 memory events, attention state, UI prefs) | `MAX_MEMORY_EVENTS = 200` | 50 – 300 KB |
| `personal-notify-state:v1` | ≤1000 notified comment ids + assigned keys | 20 – 60 KB |
| `briefing:v1` | `links` ≤ 200 tickets | 10 – 40 KB |
| `reminder-index:v1` | one item per parked ticket | 5 – 30 KB |
| `notify-prefs:v1`, `notify-digest:v1`, `cron-heartbeat:v1`, `cron-progress:v1` | small | < 2 KB each |
| `jira-write-log:v1` (list) | `JIRA_WRITE_LOG_MAX_ENTRIES = 1000` | up to ~300 KB if read in full |

## Ranked budget (per day, ESTIMATE)

Cron: `.github/workflows/sync.yml` runs every 15 min = **96 ticks/day**. Per member per tick (code: `jira/cron-tick.ts`):
notify state get+set (set is unconditional), prefs get, digest get, reminder index get, briefing get (+ reminder index
get again when a briefing is due), heartbeat get+set, progress set. **After `REPORT_SNAPSHOT_HOUR_LOCAL` on a workday every
tick also does `server-reports` get + set** (`runServerDailySnapshot` re-runs and merges into the same day), i.e. a full
read AND full write of the 60-day blob on every remaining tick of the day.

| # | Route / source | Calls/day | Bytes per call | Bytes/day | Basis |
|---|---|---|---|---|---|
| 1 | cron-tick: `server-reports` get+set after snapshot hour | ~2 × 24–40 ticks | ~0.5 MB | **~25 – 40 MB** | ESTIMATE |
| 2 | cron-tick: `personal-notify-state` get+set (unconditional set) | 2 × 96 | ~40 KB | ~8 MB | ESTIMATE |
| 3 | cron-tick: `briefing` get, `reminder-index` get, prefs, digest, heartbeat get+set | ~8 × 96 | ~10 KB avg | ~8 MB | ESTIMATE |
| 4 | `GET reports/server` (client pulls the whole 60-day blob) | per focus/load | ~0.5 MB | up to ~10 MB per active day | ESTIMATE |
| 5 | `GET state` (pull on focus / visibility) | per focus | ~150 KB | ~3 MB per active day | ESTIMATE |
| 6 | `POST state` (debounced, 2.5 s) | per change | ~150 KB | ~1 – 3 MB | ESTIMATE |
| 7 | `GET state` as a status probe (fixed in V2.52.2) | every page load ×3 components | ~150 KB | was ~1 – 5 MB | ESTIMATE |
| 8 | `POST briefing` (mirror on every recompute) | per mirror | ~20 KB | ~0.5 MB | ESTIMATE |
| 9 | `POST reminders/index` | per mirror | ~15 KB | ~0.3 MB | ESTIMATE |
| 10 | `GET health` | memoized 30 s/instance | ~1 KB | negligible | ESTIMATE |
| 11 | `jira-write-log` lrange | per list | up to ~300 KB | small | ESTIMATE |
| 12 | `smembers invites` (every sign-in) | per sign-in | < 1 KB | negligible | ESTIMATE |

Row 1 alone is the likeliest cause of a ~10 GB/month burn on a single member (≈ 30 workdays × 30–40 MB ≈ 1 GB) —
and it grows with team size and with the 60-day blob; several active members and open tabs account for the rest.
**These are estimates; run the metrics before judging.**

## What changed (V2.53) — one commit per fix, each independently revertable

| Fix | Change | Revert |
|---|---|---|
| 0 | `KV_METRICS=1` call log, `scripts/kv-metrics-report.mts`, this doc | revert the phase-0 commit |
| 1 | prefs read once per tick; notify state not rewritten when only its cursor moved (< 1 h old); optional `mget` on `KvLike`; `sync.yml` cadence note | revert fix 1 (the mget seam stays harmless) |
| 2 | `server-reports` split per day (`…:v2:baseline`, `…:v2:<date>`, `…:v2:index`); legacy blob read as a fallback and migrated on the first write; cron writes only what changed; `GET reports/server?since=` | revert fix 2 — **but** once migrated, the reverted code would not see v2 keys: re-seed or accept that history restarts (legacy blob is deleted after migration). Prefer fixing forward. |
| 3 | `GET state?knownUpdatedAt=` + `app-state-meta:v1`; focus pulls ≥ 60 s apart; no push when nothing is pending | revert fix 3 (the meta key is harmless and ignored) |
| 4 | Briefing mirror skips an unchanged payload | revert fix 4 |

## Before / after (MEASURED on the in-memory KV with the metrics wrapper; sizes are invented, see below)

`npx tsx scripts/kv-bandwidth-sim.mts` — 3 members, one steady-state cron tick each (after the snapshot hour, nothing new),
20 focus events over ~3 min, 10 state edits. BEFORE replays the pre-V2.53 access pattern, AFTER runs the real code.
Seeded sizes: reports 60 days × 40 tickets (~0.6 MB/member), app-state ~100 KB, notify state ~15 KB, briefing ~20 KB.

| Scenario | KV calls | Bytes before | Bytes after | Saved |
|---|---|---|---|---|
| Cron tick, 3 members (steady state) | 36 → 30 | 1.77 MB | 0.12 MB | ~93 % |
| 20 focus events (device current) | 20 → 4 | 1.91 MB | 0.2 KB | ~100 % |
| 10 state edits (reconcile + push) | 20 → 39 | 1.91 MB | 1.82 MB | ~5 % |
| First tick after deploy (one-time legacy migration, 3 members) | — | — | 3.4 MB | one-off |

Scaled to a day (96 ticks, ~28 of them after the snapshot hour on a workday) the report blob alone was ~25–40 MB per member;
it is now a few MB. Real numbers will differ — **re-measure with `KV_METRICS=1` on the deployment.**

## Remaining hotspots (not changed)

- **`POST state` still writes the whole blob per edit** (the push itself): the sim shows it dominating once reads are gone.
  Next step if the quota is still tight: a per-field or chunked state, or a longer debounce for non-critical fields.
  Not done: it needs a data-model change and nothing showed which fields are lossless to drop.
- **`app-state` and the other blobs are not trimmed** (`MAX_MEMORY_EVENTS`, decisions): no measurement says they are large.
- The cron still does one KV read of ~6 small blobs per member per tick. Lowering the cadence in `.github/workflows/sync.yml`
  (`*/30` or hourly; the default stays `*/15`) is the next lever, at the price of later notifications.
- Snapshot ticks after the snapshot hour still re-query Jira every tick (Jira cost, not KV): a minimum interval between snapshot
  runs would also cut that; not added because it changes when late mentions reach the day's report.
- Not changed by design: gzip/compact JSON (no benefit at the Upstash REST layer), the Jira write log (already `lrange` of 50),
  the health probe (already memoized 30 s), the reminders mirror (already skips an unchanged index).

## After deploy: what to check on the Upstash dashboard

- Daily **bandwidth** (the quota that was hit) trending down day over day, not just commands.
- **Commands/day** (should drop too once reads are skipped/batched).
- Storage steady (the report split must not grow it: legacy blob is deleted after fan-out).
