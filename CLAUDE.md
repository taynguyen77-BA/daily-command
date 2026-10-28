# CLAUDE.md — Daily Command (BA/PO/PM Command Center)

Place this file at the repository root. Claude Code reads it at the start of every session.

## What this is
Next.js 16 (App Router, React 19, Tailwind 3) app that turns Jira data into deterministic delivery intelligence
(priorities, risks, attention queue, personal focus, reports) plus optional, opt-in task-level AI.
State is local-first (one IndexedDB blob, cross-tab rebase, optional cross-device sync). Server state lives in KV
only for: notify baseline, cross-device sync blob, daily snapshots, write log, AI usage, and (team mode) users.
Team sign-in (NextAuth v4) is OFF unless `AUTH_ENABLED=true`.

## Commands
- `npm run dev` · `npx tsc --noEmit` · `npm run lint` · `npm test` · `npm run build` · `npm run check` (tsc + eslint + tests)
- `npm test` runs `scripts/tests/run.mts` (~3,400 offline checks, ONE process, shared `commandCenterStore` singleton —
  file order in `FILES` is part of the contract).
- Lint locally also scans git-excluded `.claude/worktrees/*` (hundreds of errors that CI never sees); lint from a clean clone or ignore that folder.
- `PERF_BUDGET_FACTOR=3 npm test` on slow machines/CI (perf budgets are multiplied by it; default 1).

## Map
- `src/lib/command-center/*` — pure engines (scoring, risk-detection, attention-queue, personal-focus,
  ticket-work-state, reports…). No I/O.
- `src/lib/command-center/jira/*` — Jira http/normalize/mapping. Network is injected as `FetchLike` so tests stay offline.
- `src/lib/command-center/ai/*` — AI: `task-registry.ts` → `server-runner.ts` → grounding guard (`evaluation.ts`).
  The browser sends `{ task, input }`; the SERVER builds the prompt.
- `src/lib/server/*` — `server-only`: Jira credentials, KV clients, Slack.
- `src/app/api/command-center/*` — thin routes; logic belongs in `src/lib`.
- `src/components/command-center/*` — UI. `use-command-center.ts` is the state hook.
- Monoliths — do NOT grow: `store.ts` (~3.2k lines), `types.ts` (~2k), `app/data-settings/page.tsx` (~1.9k),
  `query-router.ts`. Put new logic in NEW modules; touch these files only for minimal wiring (≈30 lines each).

## Rules (non-negotiable)
1. **Trust labels.** Every displayed claim is CALCULATED, EVIDENCE, AI DRAFT, USER INPUT or UNKNOWN. Two more exist
   for learning/forecasting: **LEARNED** (derived from the user's own history; shows sample size, can be switched off
   and reset) and **FORECAST** (statistical; shows sample size; says "insufficient history" instead of guessing).
   Never fabricate a value for a missing field — contribute 0, lower `confidence`, say so.
2. **Additive only.** Do not remove features, routes, fields or env vars. Persisted state only grows (optional fields);
   an old stored blob must still load (add a parse test when a shape changes). New switches default to the previous behaviour
   unless a prompt explicitly says otherwise.
3. **Tests.** New behaviour = new numbered file in `scripts/tests/`, appended to `FILES` in `run.mts`, using
   `ok(group, cond, msg)` from `harness.mts`. Offline only. Bug fixes are red-first (show the test failing before the fix).
   Fakes for Jira must validate JQL (use `strictJiraFake()` once it exists) — a fake that ignores the JQL hides bugs.
4. **Version line.** `package.json` `version` is the source of truth; README has exactly one `**Current version:** V2.NN`
   line and must match (test E6). Add ONE short `(V2.NN)` section per release to `docs/RELEASE-NOTES.md` (README is a short entry point; env vars live in `docs/CONFIG.md`); never a heading newer than package.json.
5. **Security.** Jira/Anthropic/Slack secrets never reach the browser, logs or responses. Secret comparisons are
   constant-time (`secure-compare.ts`). Jira writes only through the existing gated route.
6. **AI.** Prompts are built on the server, outputs validated by schema + grounding guard, deterministic fallback always
   available. Respect the daily token cap. Prefer reusing an existing task over adding one; prefer fast tier for narration.
   Do not send ticket content for projects outside the allow-list.
7. **Jira JQL dates** must go through the shared formatter (`buildIncrementalSinceParam` semantics: `yyyy-MM-dd HH:mm`,
   tz-offset aware, 5-minute safety buffer). Never interpolate an ISO-8601 string into JQL.
8. **Style.** Acceptance criteria are checklists (never Given/When/Then). Keep UI strings accurate: do not claim a
   capability is missing/present without reading the flags that decide it.

## Definition of Done (every change)
- [ ] `npx tsc --noEmit` clean · [ ] `npm run lint` 0 errors, no new warnings · [ ] `npm test` all green
- [ ] `npm run build` succeeds · [ ] new tests registered in `run.mts` · [ ] version + README line/section updated
- [ ] backward compatibility shown (old state loads; defaults unchanged unless stated) · [ ] no secret in logs/responses
- [ ] final report: files changed, tests added (names), deviations from the prompt, follow-ups
