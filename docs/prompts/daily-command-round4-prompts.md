# Daily Command — Round 4 Prompts (V2.48.4 → V2.52.0)

Reviewed: `daily-command-main (2).zip` @ **V2.48.4**, clean `npm ci`.
`tsc --noEmit` clean · `npm test` **4,527 / 4,527 passed, 0 failed, 3 skipped** (65 files).

**Not verifiable by the reviewer:** live Claude / your gateway (no key in the sandbox), real Jira, a real browser.
Every AI conclusion below comes from reading code, from running the real modules against fakes, or from computing schema
ceilings with the repo's own Zod schemas. Items that need a live check say so.

Method for every prompt: read `CLAUDE.md` first, plan before coding, red-first for bug fixes, one prompt ≈ one PR,
Definition of Done from `CLAUDE.md`. Acceptance criteria are checklists (happy path / validation / error / edge), never Given/When/Then.
Test file numbers below (65…70) mean "the next free number" — use the next free number at the time you run it and append to `FILES` in `run.mts`.

---

## 0. Release plan

| Release | Prompt | Theme |
|---|---|---|
| V2.49.0 | **A1** | AI call foundation: per-call outcome + failure reasons, Next-Best-Action AI gate bug, output-token budgets + truncation retry |
| V2.50.0 | **R1**, **R2** | **Report Narrative**: a 3–5 sentence summary of the day/week (standup or work-log style, EN/VI), in Reports, exports and Close Day |
| V2.51.0 | **A2**, **A3** | Every AI feature labelled from its own call's outcome; prompt/language/short-circuit quality pass |
| V2.52.0 | **A4** | Self-test covers all AI tasks; per-task AI health rates with alerts |

Run **A1 first**: R1/R2/A2 build on its `AiOutcome` type. If you want the report feature immediately, A1 can ship as a small PR
(it is mostly additive plumbing) and R1 follows the same day.

---

## 1. Review

### 1.1 Reports — verdict

| Area | Verdict | Evidence |
|---|---|---|
| Daily / Weekly report engine (`reports.ts`) | **Works** | Events vs standup state kept apart, never fabricates, server snapshot merge, dedupe, 4,527 checks green. |
| Deterministic summary paragraph (F5) | **Works, but is the wrong shape for your need (R-1)** | `report-summary.ts`: counts + top blocker + biggest risk. |
| "Polish with AI" | **Cannot fix R-1 and fails opaquely (R-2)** | `ReportSummary.tsx`, `prompts/report-summary-polish.ts`. |
| "Rewrite for…" (audience reports) | **Works, OFF by default, rewrites the whole report (R-3)** | `types.ts` `audienceReports: false`; `ReportRewrite.tsx`. |
| Exports (Markdown / Slack / text) | Works | `renderReportHeader` puts `summary` under the title. |

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **R-1** | P1 | **The report summary states counts, not work.** Today's output is literally `"3 done, 2 in progress, 1 blocked, 4 new, 2 mentions awaiting reply. Top blocker: ABC-1 <title> — blocked 3 business days (<note>). Biggest risk: <title> (HIGH)."` It names no completed ticket, no theme, no project, so it cannot be spoken in a daily or pasted into a work log. | `report-summary.ts` `dailySummary` (L80) / `weeklySummary` (L97); `reports.ts` L413. |
| **R-2** | P1 | **"Polish with AI" cannot add the missing content and its failure message is wrong.** Its only input is the counts paragraph; the prompt forbids new facts and `checkPolishPreservesFacts` demands identical numbers and keys, so the best possible output is a rephrase of a counts line. When the call fails for any reason (budget, grounding, truncation, gateway) the UI says *"The AI kept the summary as it is (Mock AI never rewrites)"* — misleading. | `ReportSummary.tsx` L54; `claude-provider.ts` `polishReportSummary` falls back to the same text. |
| **R-3** | P2 | **"Rewrite for…" is hidden and is not a summary.** `audienceReports` defaults to `false`, so the buttons are not on the page. When on, it rewrites the **entire** report (up to 12,000 chars), not a 3–5 sentence paragraph. It also detects "AI not used" with `out === redacted` + the shared `provider.mode`. | `types.ts` L1865; `ai/report-rewrite.ts` L114. |
| **R-4** | P2 | **Weekly summary ignores the week's shape.** `doneGroups` (done by project/sprint), carried-over and next-week lists exist in `WeeklyReportView` but the weekly paragraph only counts them. | `reports.ts` `buildWeeklyReportView` L690–L710. |
| **R-5** | P3 | A report over 16,000 characters silently fails the task input schema (`rewriteReport.report: str(16_000)`) → generic "AI rewrite unavailable", no cause. | `task-registry.ts`. |
| **R-6** | P3 | A new narrative has to enter the exports; today only `summary` does. | `reports.ts` `renderReportHeader`. |

**Target (illustrative, invented tickets).** Daily, standup style, EN:

> Today I completed 4 tickets across 2 projects, including ABC-101 (Reminder email copy) and DEF-212 (Contrast fix on login). I'm continuing with 2 tickets in progress, mainly ABC-110 (Expiry date API contract). ABC-120 has been blocked for 3 business days, waiting on the Dev Team for the API spec. 2 mentions are awaiting my reply and 1 blocker is over SLA.

Daily, work-log style:

> On 2026-11-07 I completed 4 tickets across 2 projects: ABC-101 (reminder email copy), ABC-104, DEF-212 and DEF-215. I also progressed 2 tickets (ABC-110, ABC-111). ABC-120 remained blocked (3 business days).

Always 3–5 sentences, no invented facts, every number and ticket key traceable to the report.

### 1.2 AI features — verdict

29 AI tasks behind ~16 user-facing features. The foundation is strong: server-built prompts, Zod input/output schemas, grounding guard with VN-aware dates,
one schema/grounding repair, allow-list + redaction, daily cap, usage ledger, self-test. The problems are in the seams.

| ID | Sev | Finding | Evidence | Verified how |
|---|---|---|---|---|
| **A-1** | P1 | **"Next Best Action wording by AI" never calls the model on a fresh page, and then burns its once-a-day budget on deterministic text.** `callAi` gates on `provider.mode !== "claude"` *before* any call, but `ClaudeProvider._mode` starts as `"mock"` and only changes after a call. `index.ts` itself says `mode` is "for UI labeling only". `narrateNextBestActions` then stores the deterministic text for the day, and later fact changes the same day return deterministic text "still no call". | `NextBestActions.tsx` L75; `claude-provider.ts` L110 (`_mode = "mock"`); `nba-narration.ts` L62–L63; `ai/index.ts` L10. | Read; the logic is unambiguous. Add a red-first test (A1). |
| **A-2** | P1 | **Failure reasons are discarded at the UI.** The provider records `errorKind` / `providerState`, but every feature renders only "AI unavailable" / "Deterministic (AI not used)". A budget stop, a grounding rejection, a truncation, a wrong gateway model and "no key" all look identical. The plain-language causes shipped in V2.46 exist only in the provider panel and self-test. | `claude-provider.ts` `fallback()`; components listed in A2. | Read. |
| **A-3** | P1 (gateway) | **Output-token budget is too small for several tasks and the thinking headroom is an exact-id allow-list.** `visibleTokenBudget` returns 512 for 17 tasks; `isAlwaysThinkingModel` only recognises exact Anthropic ids, so a gateway id such as `anthropic/claude-sonnet-4.5` gets **only** the visible budget. `max_tokens` → `errorKind: truncated` → 502 → **no retry** → Mock text. At-risk: `weeklyInsights` (3–5 observations that each quote verbatim evidence + 3 suggestions; schema ceiling ≈ 2,800 tokens EN, realistic 600–1,000), `generateWeeklyReview` (10 mandatory headings, realistic 600–900). Vietnamese costs roughly 1.5–2× the tokens of English. You use a custom gateway (V2.48.1–2.48.4), so this is your case. | `task-registry.ts` `visibleTokenBudget`; `model-config.ts` `isAlwaysThinkingModel`; `server-runner.ts` L227. Ceilings computed from the repo's Zod schemas (table below). | Ceilings computed; **confirm on your gateway with `npm run smoke:ai`** (look for `truncated`). |
| **A-4** | P2 | **Self-test covers 12 of 29 tasks.** No fixture for: `analyzePriorities`, `detectRisks`, `explainChanges`, `generateActionPlan`, `generateCommunication`, `generateEndOfDaySummary`, `interpretTrend`, `detectDecisionConflicts`, `analyzeActionOutcomes`, `generateWeeklyReview`, `answerQuery`, `assessProactive`, `generateProjectStory`, `generateDecisionOptions`, `interpretOutcome`, `generateCommunicationArtifact`, `polishReportSummary`. | `ai/selftest-fixtures.ts`. | Counted. |
| **A-5** | P2 | **Weekly Review spends a model call to say "insufficient history".** The `!hasEnoughHistory` branch of the prompt contains no facts; the answer is a deterministic fact and the model may improvise. | `prompts/weekly-review.ts` L5–L12; call site `app/weekly-review/page.tsx` L113. | Read. |
| **A-6** | P2 | **Language.** Only `draftMentionReply` and `rewriteReport` take a language. Weekly insights, weekly review, end-of-day and ticket brief are English-only although you report in both. | `task-registry.ts` input schemas. | Read. |
| **A-7** | P3 | The shared `provider.mode` is global mutable state read by ~14 components after an `await`. I probed two overlapping calls (one fast failure, one slow success): the label came out right because the read happens in the same microtask continuation. Treat as a **design risk**, not a live bug; A1/A2 remove the dependency. | `ai/index.ts`, grep `provider.mode`. | Probed. |
| **A-8** | P3 | Server response cache is a module-level `Map`; on serverless each instance has its own, so dedupe is best-effort and each request reads 7 ledger days twice. Cost-only; the browser caches carry the load. Backlog. | `server-runner.ts` `sharedCache`. | Read. |
| **A-9** | info | `AI_SYSTEM_PROMPT` (~150 tokens) is sent with `cache_control`; it is far below the minimum cacheable prefix, so it has no effect. Harmless, do not invest. | `server-runner.ts` L31–L38. | Read. |

**Worst-case output ceilings vs visible budget** (computed from `TASK_OUTPUT_SCHEMAS`; "realistic" is typically 25–40% of the ceiling):

| Task | Tier | Ceiling tokens EN | Ceiling tokens VI | Visible budget |
|---|---|---|---|---|
| `weeklyInsights` | default | 2,800 | 5,091 | **512** |
| `parseCommand` | fast | 1,950 | 3,545 | 512 |
| `generateTicketBrief` | default | 3,700 | 6,727 | 1,536 |
| `checkRequirements` | deep | 4,125 | 7,500 | 1,536 |
| `generateWeeklyReview` / `generateCommunicationArtifact` / `explainChanges` / `generateActionPlan` | mixed | 1,000 | 1,818 | **512** |
| `assessProactive` | default | 875 | 1,591 | **512** |
| `rewriteReport` | default | 3,000 | 5,455 | 4,096 |

What works and should not be touched: grounding guard (dates, derived counts, people), schema/grounding single repair, server-built prompts,
allow-list + redaction, per-task fact checks (`TASK_EXTRA_CHECKS`), the daily cap and ledger, key sealing.

---

## 2. Shared block — paste at the top of every prompt below

```
Before anything else read CLAUDE.md (rules, Definition of Done) and the V2.46–V2.48 sections of docs/RELEASE-NOTES.md.
Next.js here is NOT the one you know: read node_modules/next/dist/docs/ before touching routes.
Rules that matter most here: additive only (no removed features/routes/fields/env vars; persisted state only grows with optional fields and a parse test
for an old blob); trust labels on every displayed claim; AI is on-demand, prompts are built on the server, outputs are schema + grounding validated and a
deterministic fallback always exists; secrets never reach browser/logs; do not grow the monoliths (store.ts, types.ts, data-settings/page.tsx,
query-router.ts) beyond ~30 lines of wiring each; acceptance criteria are checklists, never Given/When/Then; no unnecessary AI token consumption.
Plan first and show the plan. Bug fixes are red-first (show the failing test before the fix). Register every new test in scripts/tests/run.mts.
Finish with: files changed, tests added (names), deviations from this prompt, follow-ups. Run: npx tsc --noEmit, npm run lint, npm test, npm run build.
```

---

## 3. Prompts

### A1 — AI call foundation (V2.49.0)

**Goal.** Every AI call returns an explicit outcome (success, or a typed failure reason); the Next-Best-Action AI wording works; truncation stops being a silent
fallback. No behaviour change on today's success paths.

**Read first:** `ai/claude-provider.ts` (`call`, `fallback`), `ai/provider.ts` (interface + `MockAIProvider`), `ai/server-runner.ts` (`callAndValidate`),
`ai/task-registry.ts` (`visibleTokenBudget`), `ai/model-config.ts` (`isAlwaysThinkingModel`), `ai/usage-ledger.ts`, `components/command-center/NextBestActions.tsx`,
`lib/command-center/nba-narration.ts`, `AiProviderPanel.tsx` and `ai/provider-handlers.ts` (existing plain-language error causes — reuse their texts).

**Build:**

1. `ai/outcome.ts` (new, pure, no I/O):
   - `type AiFailureReason = "unavailable" | "budget" | "user-budget" | "grounding" | "truncated" | "invalid-output" | "refused" | "provider-error" | "network" | "bad-input"`
   - `type AiOutcome<T> = { ok: true; data: T } | { ok: false; reason: AiFailureReason; httpStatus?: number; violationCount?: number }`
   - `explainAiFailure(reason, httpStatus?): { title: string; nextStep: string }` — plain language, EN only (this is app chrome). Map: `unavailable` → "AI is not set up or not reachable", next step "Data & Settings → AI provider → Test"; `budget`/`user-budget` → "Today's AI budget is used up", "Resets at midnight UTC; the calculated text is shown"; `grounding` → "The AI used a number, date or ticket key that is not in your data, so it was rejected"; `truncated` → "The answer was cut off"; `invalid-output`, `refused`, `provider-error`, `network`, `bad-input` similarly. Reuse wording from the provider panel where it exists.
2. `ClaudeProvider`: refactor private `call()` so `fallback()` takes the reason, and add a **public** `runTask<T extends AITask>(task, input): Promise<AiOutcome<Output<T>>>`.
   All existing methods keep their signatures and behaviour (they call `runTask` and fall back to the mock exactly as today). `mode` stays (deprecated for labels, still set as today).
   Add optional `runTask?` to the `AIProvider` interface; `MockAIProvider` does not implement it (callers treat "no runTask" as `unavailable`).
3. **Next Best Action fix (red-first).** In `NextBestActions.tsx` `callAi` must not read `provider.mode`. Use `runTask("generateDailyGuidance", …)`.
   `narrateNextBestActions` must (a) persist the day's marker only when a call actually happened, (b) after a transient failure (`network`, `provider-error`, `truncated`) allow one more attempt later that day (max 2 attempts/day), (c) after a definitive failure (`budget`, `grounding`, `unavailable`) stop for the day, (d) return the reason so the UI can show `explainAiFailure` as a quiet tooltip. Cache by facts hash unchanged.
4. **Budgets.** In `task-registry.ts` add `visibleTokenBudget(task, opts?: { language?: "en" | "vi" })`: result = `max(current, min(3072, ceil(schemaMaxChars / 4 × 0.5)))`, ×1.6 when `language === "vi"` (cap 6144); keep every existing explicit value as a floor.
   Compute `schemaMaxChars` from the output schema once per task (see the ceiling table above; reuse `schema-limits.ts` walking logic). Add `thinkingHeadroom(model, { customBaseUrl })` in `model-config.ts`: known always-thinking Claude ids → 6000 (unchanged); a custom base URL **or** an unrecognised id → 2048; known non-thinking Claude ids → 0. `isAlwaysThinkingModel` stays exported and unchanged.
5. **Truncation retry.** In `server-runner.ts` `callAndValidate`: on `stopReason === "max_tokens"` at attempt 0, retry once with `maxTokens × 2` (cap `8192 + headroom`), log outcome `truncated-retry` (add to the ledger union, optional field), re-check the daily cap first. Still truncated → `truncated` as today. Total model calls per request stay ≤ 2 (the retry shares the existing attempt loop with the schema/grounding repair).
6. Propagate `errorKind` and `violations.length` from the server JSON into the `AiOutcome` (the route already returns them).
7. `components/command-center/AiFailureNote.tsx`: tiny presentational component `<AiFailureNote reason httpStatus />` rendering `explainAiFailure` as one muted line with the next step.
8. Docs: `docs/RELEASE-NOTES.md` one `(V2.49)` section under a new `## Round 4` heading, README version line, `package.json` → 2.49.0.

**Acceptance criteria**

- [ ] Happy: with a fake fetch returning a good `generateDailyGuidance`, a **fresh** `ClaudeProvider` produces NBA narration with `source: "ai"` (this test fails before the fix).
- [ ] Happy: `runTask` returns `{ ok: true, data }` for every task fixture in `selftest-fixtures.ts` (fake server).
- [ ] Happy: all existing methods return exactly what they returned before for success and for failure (existing tests 02, 31, 32, 33, 56, 57, 64 stay green unchanged).
- [ ] Validation: each server `errorKind` / HTTP status maps to the documented `AiFailureReason` (table-driven test: 429 → `budget`, 422 → `grounding`, 502 `truncated`, 502 `invalid-output`, 502 `refused`, 401/404 → `provider-error`, thrown fetch → `network`, schema-invalid input → `bad-input`, availability false → `unavailable`).
- [ ] Validation: `visibleTokenBudget("weeklyInsights") ≥ 1024`, every task budget ≥ its previous value, VI ≥ 1.6× EN capped at 6144; `thinkingHeadroom` table test incl. gateway id `anthropic/claude-sonnet-4.5` → 2048.
- [ ] Error: first call `max_tokens`, second call fine → request succeeds, ledger shows `truncated-retry`, total model calls = 2; both truncated → 502 `truncated`; cap exhausted between attempts → 429, no second call.
- [ ] Error: NBA after `network` failure allows exactly one more attempt that day; after `budget` none; the deterministic text is shown in all cases.
- [ ] Edge: schema repair + truncation in one request never exceeds 2 model calls.
- [ ] Edge: old persisted NBA narration blob (`{day, hash, text, source}`) still loads; no new required fields.
- [ ] No secret or prompt text in the new outcome, logs or ledger.

**Tests:** `65-ai-outcome-and-budgets.test.mts`.

---

### R1 — Report Narrative: 3–5 sentence summary for Daily and Weekly (V2.50.0)

**Goal.** At the top of every Daily and Weekly report, show a 3–5 sentence summary of the work (what was done, what is in progress, what is blocked and since when, what needs attention)
that you can read in a daily or paste into a work log. It is **always available without AI** (calculated, deterministic); AI is an optional, on-demand upgrade of the wording.

**Read first:** `reports.ts` (`DailyReportView`, `WeeklyReportView`, `buildDailyReportView`, `buildWeeklyReportView`), `report-summary.ts`, `components/command-center/ReportSummary.tsx`,
`app/reports/page.tsx`, `ai/report-rewrite.ts` (`clientSafe*`, `isInternalNote`, `rewriteReportFlow`), `ai/task-registry.ts`, `ai/schemas/index.ts`, `ai/prompts/report-rewrite.ts`,
`ai/data-protection.ts` + `ai/redaction.ts` (allow-list, aliases), `ai/readiness.ts` + `use-ai-readiness.ts`, `ai/selftest-fixtures.ts`, `ai/usage-policy.ts`, `ai/model-config.ts`,
and how `aiWeeklyInsights` is typed, persisted, backed up and synced (copy that pattern for stored narratives). Use `grep -rn audienceReports` to find every feature-flag registration point (types, defaults, readiness matrix, Data & Settings toggles, presets, tests).
Depends on A1 (`AiOutcome`, `AiFailureNote`).

**Design**

```
DailyReportView | WeeklyReportView
  → buildNarrativeFacts(view, { kind, style, language, includeTeam:false, allowedProjects, today })   // pure, new report-narrative.ts
  → deterministicNarrative(facts)                                                                      // pure, always 3–5 sentences, EN + VI
  → on click "Improve with AI" (feature reportNarrativeAi, on-demand only):
       browser: redact titles (RedactionSession + custom aliases) → provider.runTask("summarizeReport", facts)
       server : parse input schema → build prompt → model → output schema → checkGrounding(strict) + TASK_EXTRA_CHECKS.summarizeReport (one repair)
       browser: re-verify (lockedFactViolations vs the facts text, countSentences ∈ [3,5], oldest blocked key present) → show AI text, else deterministic + AiFailureNote
```

**New task `summarizeReport`** (register in every place a task is registered: `aiTaskSchema` enum, `TASK_INPUT_SCHEMAS`, `BUILDERS`, `TASK_OUTPUT_SCHEMAS`, `GROUNDING_POLICY = "strict"`, `visibleTokenBudget` (1024 via A1 rule), `usage-policy` (10-minute cache), `model-config` (default tier), `AIProvider` interface, `MockAIProvider` (returns the deterministic narrative), `ClaudeProvider`, `selftest-fixtures` (EN + VI, core), readiness matrix feature `reportNarrativeAi`).

Input schema (all bounded, all optional fields genuinely optional):

```ts
summarizeReport: z.object({
  kind: z.enum(["daily", "weekly"]),
  periodPhrase: str(60),            // "Today" | "On 2026-11-07" | "This week (2026-11-03 to 2026-11-07)"
  style: z.enum(["standup", "worklog"]),
  language: z.enum(["en", "vi"]),
  counts: z.object({ done: num, inProgress: num, blocked: num, newReceived: num, mentionsAwaitingReply: num, overdueBlockers: num,
                     decisions: num, projects: num, doneNotListed: num, carriedOver: num.optional(), reportedDays: num.optional(), missingDays: num.optional(),
                     slaBusinessDays: num.optional() }),
  done: z.array(item).max(40), inProgress: z.array(item).max(25), blocked: z.array(blockedItem).max(15) /* oldest first */,
  nextWeek: z.array(item).max(15).optional(), decisions: z.array(str(300)).max(10),
  risk: z.object({ title: str(300), level: str(10) }).optional(),
})
// item = { key: str(40), title: str(200).optional(), project: str(100).optional() }
// blockedItem = item + { ageBusinessDays: num.optional(), waitingFor: str(200).optional(), reason: str(300).optional() }
```

Output schema: `reportNarrativeResponseSchema = z.object({ text: z.string().min(40).max(1000) })`.

**What is and is not sent (CLAUDE.md rule 6).** Titles, `reason` and `waitingFor` only for tickets of **allow-listed** projects; for other projects send key + project name only (and the UI says
"N tickets summarized by key only — project not on the AI allow-list"). Never send: assignee/teammate names, skipped items and skip reasons, mentions' text, any note matching `isInternalNote`, team-done tickets (counts only if `includeTeam`), removed-from-scope. Pattern redaction + custom-term aliases as `rewriteReportFlow` does; restore aliases after.

**Server prompt (`ai/prompts/report-narrative.ts`)** — build from the input, ending with the generated `OUTPUT LIMITS` as every prompt does:

```
You write what an IT Business Analyst says at a daily standup or records in a work log, from the facts below.
Write in {English|Vietnamese (tiếng Việt; keep ticket keys, product names and English technical terms as written)}.
Output: ONE paragraph of EXACTLY 3 to 5 sentences. Plain text. No bullets, no markdown, no emoji, no headings.
Refer to the period as: "{periodPhrase}" (copy it exactly).

COUNTS (the only numbers you may use besides numbers inside the lists):
done={n} in-progress={n} blocked={n} new={n} mentions-awaiting-reply={n} blockers-over-SLA={n} decisions={n} projects={n} done-not-listed={n} …

DONE:        - KEY — title (project)
IN PROGRESS: - …
BLOCKED (oldest first): - KEY — title — {n} business days — waiting for … — reason …
NEXT WEEK / DECISIONS / BIGGEST RISK: …

STYLE standup: first person. Order: what I finished → what I am working on → what is blocked, since when and on whom → what needs attention (mentions awaiting reply, blockers over SLA, decisions).
STYLE worklog: neutral past tense for a timesheet or work log. What was completed (group by project, name up to 4 key tickets), what was progressed, one clause on anything blocked. No requests, no plans.
RULES:
- Mention at most 6 ticket keys. If any ticket is blocked, always name the OLDEST blocked ticket's key.
- Use only numbers from COUNTS or the lists; do not count or add anything yourself. Say "and N more" only with done-not-listed.
- Never invent causes, owners, dates, estimates, effort/hours, opinions or recommendations. Do not describe a ticket in a section it is not in (a blocked ticket is never "done").
- If a section is empty, say so in a short clause. You must still write 3 to 5 sentences.
REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }
```

`TASK_EXTRA_CHECKS.summarizeReport` (server and browser share the helpers in `report-narrative.ts`): sentence count ∈ [3,5] (`countSentences` below), `text.length ≤ 1000`, oldest blocked key present when `blocked.length > 0`, no key from `blocked` (and not in `done`) in a sentence containing a completion verb (`completed|finished|done|closed|shipped|hoàn thành|xong|đã đóng`), at most 6 keys.

`countSentences(text)`: split on `.`, `!`, `?`, `…` followed by whitespace and an uppercase letter (Latin or Vietnamese), digit, quote or bracket; do not split inside ticket keys, decimals (`3.5`), ISO dates, or `e.g.` / `i.e.` / `vs.` / `etc.`; a trailing fragment without terminator counts as a sentence. Unit-tested in EN and VI.

**Deterministic narrative (`buildNarrative`)** — pure, EN + VI templates, always 3–5 sentences, never fabricates, caps listings at 3 keys per sentence + "and N more" from `doneNotListed`:
- S1 done (daily: standup "Today I completed N tickets across P projects, including K1 (title) and K2 (title)." / worklog "On <date> I completed N tickets across P projects: K1, K2, K3 and K4.") — if N = 0: "No completed tickets are recorded for <period>."
- S2 in progress (names ≤ 2 keys) — if none: "Nothing is recorded as in progress."
- S3 blockers: oldest blocked key + age + waitingFor/reason when present — if none: "No blockers are recorded."
- S4 attention (only when mentions > 0 or overdueBlockers > 0 or decisions > 0), merged into S3 for worklog.
- Weekly adds S5 carried over / next week ("N tickets are carried over from before this week; next week has M open assigned or scheduled re-checks.") and a "Only X of Y working days have a report." clause when `missingDays > 0`.
Titles are used only when present in the facts (allow-list gate applies to the deterministic text too **only for the AI path**; the deterministic text is local and may use all titles).

**UI — `components/command-center/ReportNarrative.tsx`** (placed above `ReportSummaryParagraph` in both the Daily and Weekly panels of `app/reports/page.tsx`; keep the old paragraph, relabel nothing):
- Header "Summary" + `TrustLabel`: CALCULATED for the deterministic text, AI DRAFT for the AI text, USER INPUT once edited.
- Segmented controls: **Standup | Work log** and **EN | VI** (last choice remembered in an optional state field `reportNarrativePrefs`, default standup + EN).
- Editable text area (3–5 sentences), **Copy** (plain text), **Reset to calculated**, **Improve with AI** (only when `features.reportNarrativeAi`; disabled with the readiness tooltip otherwise).
- Status line: source (Calculated / AI, model tier) + time; when the report changed since generation (facts hash differs) show "Report changed since — Regenerate" (same pattern as Ticket Brief's "Updated since brief").
- Failure: `<AiFailureNote>`; the deterministic text stays. Never block the page on AI.
- Hidden when `view.noData`.
- Store AI/edited narratives per `${kind}:${periodKey}:${style}:${language}` in optional state `reportNarratives` (≤ 90 entries, oldest evicted), following the `aiWeeklyInsights` persistence/backup/sync pattern; old blobs must load.

**Feature switch:** `reportNarrativeAi` (default **off**, like every AI feature) in Features, readiness matrix (feature count and the tests asserting "12 features" are updated), and in the **Recommended** preset (the preset diff dialog shows it).

**Acceptance criteria**

- [ ] Happy: a daily report with 4 done / 2 in progress / 1 blocked renders a 3–5 sentence calculated summary naming ≥ 1 done ticket and the blocked ticket with its age; switching Standup ↔ Work log and EN ↔ VI changes the text accordingly; Copy puts exactly the visible text on the clipboard.
- [ ] Happy: weekly report summary mentions the week's done count by project, carried-over / next-week counts, and the blocker.
- [ ] Happy (AI on): "Improve with AI" returns text that passes the server and browser checks; label switches to AI DRAFT; reopening the same report costs no model call (stored by facts hash).
- [ ] Validation: every generated text (calculated and AI) has 3–5 sentences by `countSentences` across a fixture set of ≥ 12 reports (empty day, only done, only blocked, 60 done tickets, VN titles, weekly with missing days, identity not configured).
- [ ] Validation: every ticket key in the text is in the facts; every number is in COUNTS or the lists; no blocked-only key appears with a completion verb; oldest blocked key present when any are blocked.
- [ ] Validation: facts builder caps lists (40/25/15), sets `doneNotListed`, drops titles/reasons for non-allow-listed projects, drops `[internal]`/`#internal` notes, skipped items, teammate names and mention text.
- [ ] Error: model returns 6 sentences → one repair → still 6 → deterministic text + `AiFailureNote`; hallucinated key → 422 → deterministic; budget exhausted → deterministic + budget note; AI off/unavailable → deterministic, button disabled with the readiness reason.
- [ ] Error: gateway truncation is retried once (A1) before giving up.
- [ ] Edge: `noData` day shows no narrative; identity not configured shows the existing hint and `doneMine` only; titles containing emails/phones/custom terms are redacted before sending and restored after; summary is not stale after a Jira sync (facts hash).
- [ ] Edge: local date, not UTC, is used for `periodPhrase`; "Today" only for the current local day.
- [ ] Back-compat: with `reportNarrativeAi` off and no stored narrative, existing report exports are byte-identical (golden test against current fixtures); old state blob without `reportNarratives` / `reportNarrativePrefs` loads.
- [ ] Security: the new task input never contains assignee names, skip reasons or internal notes (assert on the serialized request); no prompt text or key in logs.
- [ ] The readiness matrix lists `reportNarrativeAi` with correct statuses (OFF / NEEDS_KEY / NEEDS_ALLOWLIST / CAP_REACHED / READY) and its button tooltip equals the matrix next step.

**Tests:** `66-report-narrative.test.mts` (pure builder, counting, facts builder, server task with a fake model, browser verification, UI-state helpers, persistence parse), plus update the tests that assert the task count / feature count / preset diff.

---

### R2 — Narrative everywhere you report (V2.50.0)

**Goal.** The narrative is one click away from every place you actually report: exports, Slack/Markdown copies, Close My Day, Daily Review; and the misleading "Polish" message is fixed.

**Read first:** `reports.ts` `renderReportHeader` / `renderDailyReport` / `renderWeeklyReport` / `RenderOptions`, `report-export.ts`, `app/reports/page.tsx` (`CopyButtons`, `ShareButtons`), `CloseDayModal.tsx`, `app/daily-review/page.tsx`, `ReportSummary.tsx`, `ai/readiness.ts` presets.

**Build**

1. `RenderOptions.narrative?: string`: when set, `renderDailyReport` / `renderWeeklyReport` print it as the first paragraph under the title (text / Markdown / Slack mrkdwn, escaped the same way as other text), then the existing `summary` line and sections unchanged. Not set → output byte-identical to today.
2. Reports page: pass the visible narrative to `CopyButtons` and `ShareButtons`; add **Copy summary only** next to the full copy (copies just the narrative).
3. Close My Day modal and Daily Review: render the same `ReportNarrative` (compact, daily, today) so the end-of-day flow ends with a copyable summary. Reuse the component; no second implementation, no new AI task.
4. `ReportSummaryParagraph` ("Polish with AI"): replace the *"Mock AI never rewrites"* message by the real reason from `runTask` (`explainAiFailure`); when the call succeeded but the text equals the input say "The AI found nothing to improve". Keep the button and the preservation guard.
5. `ReportRewrite` keeps its behaviour; switch its "AI not used" detection from `out === redacted` + `provider.mode` to the outcome (finished in A2 for all flows; do only this one here if A2 has not run).
6. Docs: `(V2.50)` release-notes section, README line, `package.json` 2.50.0.

**Acceptance criteria**

- [ ] Happy: with a narrative visible, Copy (Markdown / Slack / plain) starts with the narrative, then the existing report; Slack text uses `*bold*`/escaping rules unchanged for the rest.
- [ ] Happy: Close My Day shows the narrative for today and Copy works; Daily Review likewise.
- [ ] Validation: narrative text containing `*`, `_`, `<`, `>`, `&` is escaped per format; ticket keys remain plain.
- [ ] Error: AI failure on Polish shows the specific reason, never "Mock AI never rewrites".
- [ ] Edge: weekly export with narrative + insights ("Include in copies") keeps both in order (narrative, summary, … insights).
- [ ] Back-compat: all existing report-render tests (13, 14, 18, 24) pass unchanged; golden bytes without `narrative` identical.

**Tests:** `67-report-narrative-exports.test.mts`.

---

### A2 — Every AI feature is labelled from its own outcome (V2.51.0)

**Goal.** No component or flow decides "AI vs deterministic" from the shared `provider.mode` any more; every feature shows the specific failure reason; labels can never contradict the answer on screen (CLAUDE.md rule 1).

**Inventory to migrate** (verify with `grep -rn "\.mode" src/components src/lib/command-center/ai`): `WeeklyInsights.tsx` + `ai/weekly-insights.ts`, `TicketBrief.tsx` + `ai/ticket-brief.ts`, `TicketAiPanel.tsx`, `SmartTriagePanel.tsx`, `MentionReplyDrafter.tsx` + `ai/mention-reply.ts`, `AiFollowUpDrafter.tsx` + `ai/blocker-followups-ai.ts`, `BaRequirementCheck.tsx`, `ai/release-brief.ts` (`runReleaseBrief`), `ai/report-rewrite.ts` (`rewriteReportFlow`), `ReportSummary.tsx`, `AskClaudeAbout.tsx`, `ArtifactEditor.tsx`, `WhyShouldICareDrawer.tsx`, `NextBestActions.tsx` (done in A1), `MeetingNotesActions.tsx` + `ai/meeting-actions.ts`, `CommandBar.tsx` + `ai/nl-commands.ts`, `app/weekly-review/page.tsx`, `CloseDayModal.tsx`.

**Build**

1. For each, call `provider.runTask(...)` (or a thin helper that returns `{ outcome, data }`), derive the label from `outcome.ok`, never from `provider.mode`; keep deterministic fallbacks exactly as today (same functions, same data).
2. Show `<AiFailureNote>` where AI was requested and failed; keep existing success wording ("AI draft — review before acting on it").
3. Persisted records that already store `mode: "mock" | "claude"` (ticket brief, weekly insights, mention-reply cache) keep their shape; write the mode from the outcome.
4. Guard test: a source-scan test fails if any file under `src/components` or `src/lib/command-center/ai` (except `claude-provider.ts`, `provider.ts`, `index.ts`) reads `provider.mode` / `getAIProvider().mode`, with a short allow-list for read-only diagnostics (`AiReadinessPanel`, Setup Health).
5. Docs `(V2.51)`, README, `package.json` 2.51.0 (shared with A3).

**Acceptance criteria**

- [ ] Happy: each feature's success path is unchanged (existing tests 31, 32, 33, 56 green without edits to their assertions except where they read `mode`).
- [ ] Validation: per feature, a fake provider returning `{ ok: false, reason: "budget" | "grounding" | "truncated" | "unavailable" }` yields the deterministic content **and** the matching `explainAiFailure` text; a fake returning success yields the AI label.
- [ ] Error: two overlapping calls in one session (one succeeds, one fails) each show their own correct label (concurrency test that fails on the old `mode` approach with adversarial ordering).
- [ ] Edge: stale cached AI result still labelled AI with its stored mode; "Updated since…" behaviour untouched.
- [ ] Guard: the source-scan test passes and fails when a new `provider.mode` label read is added.

**Tests:** `68-ai-outcome-labels.test.mts`.

---

### A3 — Prompt, language and short-circuit quality pass (V2.51.0)

**Goal.** Fewer wasted calls, outputs in the language you report in, tighter length control so answers stop hitting limits.

**Build**

1. **Weekly Review short-circuit (A-5).** In `app/weekly-review/page.tsx` (call site L113), when `!facts.hasEnoughHistory` produce the deterministic "not enough history yet — run Close My Day on at least two different days" text **without** a model call. Keep the prompt branch for compatibility.
2. **Language (A-6).** Add optional `language: "en" | "vi"` (default `"en"`) to the input schemas of `weeklyInsights`, `generateWeeklyReview`, `generateEndOfDaySummary`, `generateTicketBrief`; prompts add one line: "Write in {English | Vietnamese}; never translate ticket keys, product names or code identifiers." Enumerated output fields (e.g. `BRIEF_STATUSES`) stay English. A small app-wide `aiOutputLanguage` preference (optional state field, default `"en"`) drives them; the budget rule from A1 applies the VI factor. The older tasks' defaults and cache keys do not change when `language` is omitted.
3. **Length targets.** For every prompt with a free-text field, add one sentence stating the expected length ("2–3 sentences", "at most 5 bullets") that is **smaller** than the schema ceiling. Do **not** add examples or few-shot text (token cost); do **not** change schemas.
4. **Prompt audit table** committed as `docs/AI-PROMPT-AUDIT.md`: one row per task (role stated, audience, facts-only rule, length target, language handling, grounding policy, extra check, tier, budget). Flag any prompt that asks for a field the UI never shows.
5. `polishReportSummary`: keep the task; mark the UI as secondary ("Polish numbers line") since the narrative now carries the story.

**Acceptance criteria**

- [ ] Happy: with `language: "vi"` the fake-model prompt contains the Vietnamese instruction and the keys/identifier rule; with it omitted the prompt string is **byte-identical** to today for all four tasks (golden test).
- [ ] Validation: schemas still accept old inputs without `language`; cache keys unchanged when omitted.
- [ ] Error: weekly review without enough history makes **zero** model calls (spy on `fetch`).
- [ ] Edge: Vietnamese answers still pass grounding (dates `27/10`, `ngày 27 tháng 10`) in the fixtures; lengths stay under schema `max`.
- [ ] `docs/AI-PROMPT-AUDIT.md` has 30 rows (29 existing + `summarizeReport`) and a test asserts every registered task appears in it.

**Tests:** `69-ai-prompt-quality.test.mts`.

---

### A4 — Self-test for every AI task + per-task AI health (V2.52.0)

**Goal.** You can prove, from the UI and from `npm run smoke:ai`, that every AI task works on your gateway, and see per-task failure rates before users do.

**Read first:** `ai/selftest.ts`, `ai/selftest-fixtures.ts`, `ai/selftest-shared.ts`, `ai/selftest-handler.ts`, `AiSelfTest.tsx`, `ai/usage-ledger.ts` (`summarizeUsage`), the "AI health (7 days)" block in `AiProviderPanel.tsx`, `scripts/ai-smoke.mts`.

**Build**

1. Fixtures (invented data, project `SELF`, as the existing ones) for the **17 uncovered tasks** — `analyzePriorities`, `detectRisks`, `explainChanges`, `generateActionPlan`, `generateCommunication`, `generateEndOfDaySummary`, `interpretTrend`, `detectDecisionConflicts`, `analyzeActionOutcomes`, `generateWeeklyReview`, `answerQuery`, `assessProactive`, `generateProjectStory`, `generateDecisionOptions`, `interpretOutcome`, `generateCommunicationArtifact`, `polishReportSummary` — plus `summarizeReport` (EN standup, VI worklog; mark the EN one `core`, so Quick = 6 tasks; update the up-front estimate). VI variants for language-bearing tasks (`weeklyInsights`, `generateWeeklyReview`, `generateEndOfDaySummary`, `generateTicketBrief`).
2. Rubric additions in `selftest.ts`: sentence-count bounds (`summarizeReport` 3–5), forbidden causal / hierarchy phrases (reuse `evaluation.ts` patterns), `truncated`/`repaired` flags per call, per-task pass/fail with the failure reason from `explainAiFailure`. Token ceiling (`AI_SELFTEST_MAX_TOKENS`) and 3 runs/day unchanged; "Full" stays opt-in.
3. A test asserts every `AITask` has ≥ 1 fixture (so a new task cannot ship without one).
4. AI health: per task and per day, show rates of `truncated`, `grounding-rejected`, `schema-retry`, `error`; highlight a task red when > 10 % of ≥ 10 calls fail, with the matching next step ("raise the output budget / pick a different model for this tier").
5. `smoke:ai` prints the same table and exits non-zero when a core task fails (still not part of CI).
6. Docs `(V2.52)`, README, `package.json` 2.52.0.

**Acceptance criteria**

- [ ] Happy: Quick run (6 core) and Full run (all fixtures) complete against a fake model; each task shows pass/fail with its reason; cost estimate shown before running and matches the sum of `estTokens`.
- [ ] Validation: the "every task has a fixture" test passes; fixtures contain no real names, emails or keys.
- [ ] Error: a task that returns 7 sentences / a causal phrase / a placeholder leak fails the rubric with a readable message; a truncated answer is reported as `truncated`, not as a generic failure.
- [ ] Edge: token ceiling stops the run mid-way and reports the remainder as "skipped (budget)"; 4th run in a day is refused as today.
- [ ] Health: a ledger with 20 calls of which 4 truncated for one task marks only that task red.
- [ ] No fixture or health data contains tickets or comments from the real Jira.

**Tests:** `70-ai-selftest-coverage.test.mts`.

---

## 4. How to run these

1. Commit this file as `docs/prompts/daily-command-round4-prompts.md`.
2. For each prompt, start a fresh Claude Code session and send:

   ```
   Read CLAUDE.md, then docs/prompts/daily-command-round4-prompts.md sections "2. Shared block" and "<PROMPT ID>".
   Plan first and show me the plan, then implement it. Red-first for bug fixes. Finish with the final report.
   ```
3. Order: **A1 → R1 → R2 → A2 → A3 → A4**. One PR each, `npm run check` + `npm run build` green before the next.
4. After A1, on your gateway run `npm run smoke:ai` once and keep the output: if `weeklyInsights` or `generateWeeklyReview` were `truncated` before A1 and pass after, A-3 is confirmed.
5. After R1, in Data & Settings → Features turn on **Report narrative by AI**, add your projects to the AI allow-list, open Reports and click **Improve with AI** on a real day.

## 5. Backlog — deliberately not in this round

- KV-backed server response cache (A-8) — only worth it if cost, not quality, becomes the problem.
- A scheduled server-side AI summary pushed to Slack — it breaks the "AI is on-demand" rule; the calculated narrative can already feed the morning briefing without AI if you want it there.
- A **Client update** narrative style (reuse `clientSafe*` views) and an effort/time hint for work logs (needs real time-tracking data; none exists today, so nothing is estimated).
- Shrinking the system prompt/`cache_control` (A-9) — no effect at that size.
