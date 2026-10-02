# Task State Audit

This audit covers why task lists and statuses diverge across Command Center, My Day, Focus
Session, Daily Review, Priorities, Action Plan and Attention.

- **Part 1** is the audit done before any code change (Step 0), against `main` at `6adc956`
  (V2.30).
- **Part 2** documents the model that replaced it: one `TicketWorkState` per ticket, one
  selector and one `TaskRow`.

---

## Part 1 — Audit before the change (code at `6adc956`)

### 1.1 Status stores that existed

| # | Store | Keyed by | Values | Written by |
|---|---|---|---|---|
| 1 | `dailyCommandCompletions` / `dailyCommandSkips` / `dailyCommandBlocks` (+ `dailyCommandTombstones`) | Jira ticket key | present / absent (mutually exclusive) | `store.completeTicketInDailyCommand`, `reopen…`, `skipTicketInDailyCommand`, `reactivateSkippedTicket`, `blockTicketInDailyCommand`, `unblock…`, and `closePausedTicketsFinishedInJira` after a Jira sync |
| 2 | `personalPlan[].status` | plan item id (`plan-<sourceType>-<sourceId>-<ts>`) | `planned · in-progress · completed · blocked · skipped · deferred` | `start/complete/block/skipFocusItem`, `deferPersonalPlanItem`, `acceptSuggestedPlan`, `carryForward…` |
| 3 | `data.actions[].status` | action id | `open · recommended · accepted · in-progress · completed · deferred · snoozed · blocked` | `completeAction`, `deferAction`, `snoozeAction`, `markActionBlocked`, `reopenAction`, `startAction` |
| 4 | `attentionState[id].lifecycle` | attention item id (`MENTION:…`, `STALE:…`, `RISK:…`) | `NEW · ACTIVE · ACKNOWLEDGED · SNOOZED · RESOLVED · REOPENED · RE_ESCALATED` | `acknowledge/snooze/resolveAttentionItem`, `commitAttentionState` (engine) |
| 5 | Jira status + Work Relevance | work item | `WorkItem.status` / `jiraStatusName` → `ACTIONABLE · WAITING · COMPLETED · EXCLUDED · UNKNOWN` | Jira sync (read-only) |

### 1.2 Surfaces

The "status read" column says which of the stores above decides the row's state.

| Surface | Component / file | Data source / selector | Population rule | Status read | Mutations called | Actions shown |
|---|---|---|---|---|---|---|
| Command Center → **Your Delivery Focus** | `YourDeliveryFocus.tsx` + `PersonalFocusCard.tsx` | `useCommandCenter().personalFocus` → `computePersonalFocus` | non-snoozed/resolved attention items + delivery loops, gated by Work Relevance; excludes ticket ids in `dailyCommandCompletedWorkItemIds` and `dailyCommandPausedWorkItemIds` (skip ∪ block); top 3 not BLOCKED/DEFER | #1 (resolved to work-item ids in the hook), #4, #5 | `skipTicketInDailyCommand`; Start → `ensurePlanItemId` + Focus Session | **Start Focus, Skip(+reason)** only. 30-minute plan: **Start** only |
| Command Center → **My Assigned Work** | `MyAssignedWork.tsx` | `assigned-work.ts` `getActive/Blocked/Skipped/CompletedAssignedWorkItems` | Jira items assigned to identity; active = not Jira-done/excluded and not in any #1 map | #1 (by key), #5 | via `TaskReferenceRow` → the six Daily Command setters | Complete, Skip(+reason, re-check), Block(+reason, re-check, ping); Reopen / Reactivate / Unblock in history buckets |
| Command Center → **Recently Mentioned** | `RecentlyMentioned.tsx` | `selectRecentMentions(…, {completions, skips, blocks})` | mentions in last 24 h, suppressed if ticket has a #1 record older than the mention | #1, #4 | `resolveAttentionItem`, `completeTicketInDailyCommand`, `markMentionReplied` | Resolve, Mark completed, Replied |
| Command Center → **Top priorities** | `app/page.tsx` + `PriorityCard` | `derived.scores` minus `dailyCommandPausedWorkItemIds` | top 4 scores | #1 (completed via `deriveData`, paused here) | — (Take Action panel) | Take Action |
| **My Day** (`/focus`) agenda | `MyDayAgenda.tsx` | `state.personalPlan` (today) joined to `personalFocus.candidates` by `sourceType+sourceId` | today's plan items with status planned/in-progress/blocked; Done = completed | **#2 only** | `deferPersonalPlanItem`, `remove/pin/reorder…`, Start → Focus Session | Start Focus, Defer, Remove, Pin, ↑/↓ |
| **Focus Session** | `FocusSession.tsx` | candidate + plan item | one plan item | #2, #3 (linked action), #4 (linked attention item) | `startFocusItem`, `completeFocusItem` (+ `completeAction` / `resolveAttentionItem` / DecisionAssistant), `blockFocusItem` (+ `addAction("Follow up…")` only when the checkbox is ticked), `skipFocusItem` | Complete, Blocked(+reason, note, follow-up), Skip |
| **Daily Review** | `app/daily-review/page.tsx`, `daily-review.ts` | `buildDailyReview({dailyCommandCompletions, Skips, Blocks, …})` | New since baseline (assigned/reassigned/mentioned, not in #1), Due re-check, Skipped, Blocked, Completed (7 d, #1 + Jira events) | #1, #5 | `TaskReferenceRow`; keyboard: `complete/skip/blockTicketInDailyCommand`, `markDailyReviewSeen` | Complete, Skip, Block, Reopen/Reactivate/Unblock, Seen, Mark all reviewed |
| **Priorities** | `app/priorities/page.tsx` + `PriorityCard.tsx` | `derived.scores` + `dailyCommandSkipped/BlockedWorkItemIds` | all scored items; tab SKIPPED / BLOCKED shows only those, every other tab hides them | #1 | `skipTicketInDailyCommand`, `reactivateSkippedTicket` | Take Action, Skip(+reason), Reactivate. **The BLOCKED tab has no Block / Unblock / Done button** |
| **Action Plan** | `app/action-plan/page.tsx` + `PlanCandidateRow.tsx` | `buildPlan(…, completedIds, pausedIds)` | open work items not completed/paused, greedy by budget | #1 (ticket line), #3 (action buttons) | ticket line via `TaskReferenceRow ticketScoped`; action-level `completeAction`, `deferAction`, `snoozeAction`, `markActionBlocked`, `addNoteToAction`, `recordActionOutcomeStatus` | Complete/Skip/Block ticket + Complete/Defer/Snooze/Block action |
| **Attention** | `app/attention/page.tsx` + `AttentionItemCard` | `proactive.attentionQueue` | every signal; default hides SNOOZED/RESOLVED; MENTION items on a #1-completed/paused ticket are force-resolved | #4, #1 (indirectly through force-resolve) | `acknowledge/snooze/resolveAttentionItem` | What should I do?, Stakeholder update, Acknowledge, Snooze, Resolve. **No ticket status shown, no ticket actions** |
| Risk / Decision / Loop / Dependency / Change cards | `RelatedTickets` → `TaskReferenceRow` | linked work items | — | #1 | Daily Command setters | full TaskReferenceRow set |
| Reports / Standup | `reports.ts buildStandupState` | #1 maps + `personalPlan` (resolved to ticket by `ticketKeyForPlanItem`) | — | #1, #2 | — | — |

### 1.3 Root-cause bullets, checked against the code

1. **"Five parallel status stores."** Confirmed, with one detail added: the three
   Daily Command maps also carry a fourth structure, `dailyCommandTombstones`, used for
   cross-device LWW merge (`execution-state-merge.ts`). The engines see only two derived
   id-sets from #1 (`completed`, `paused = skipped ∪ blocked`, built in
   `use-command-center.ts`). `personalPlan`, actions and attention lifecycle never feed
   those sets.
2. **"FocusSession complete/confirmBlock/skip never call the ticket-level setters."**
   Confirmed (`FocusSession.tsx`: `complete()` → `completeFocusItem` + `completeAction` /
   `resolveAttentionItem`; `confirmBlock()` → `blockFocusItem` (+ `addAction` only when
   "Create a follow-up action" is ticked — it is *not* automatic); `skip()` →
   `skipFocusItem`). The candidate *does* carry `ticketKey`, so the information was
   available. Side effect: completing a MENTION candidate resolves only that one attention
   item, so the same ticket's STALE / RISK candidates stay in Your Delivery Focus.
3. **"PersonalPlanItem has no ticketKey."** Confirmed (`types.ts` `PersonalPlanItem`;
   `sourceType` is `"attention" | "loop"`). A resolver already existed but was used only by
   the standup report (`reports.ts ticketKeyForPlanItem`), so ticket-level actions never
   touched My Day rows, and My Day statuses never reached any other surface.
4. **"personal-focus.ts does not dedupe by ticketKey."** Confirmed: one candidate per
   attention item / loop. My Day's suggested plan folds only multiple **MENTION** items on
   the same ticket (`groupMentionItems`). Correction: **STALE** never reaches Your Delivery
   Focus at all — it is Attention-only by design since V2.25 (`candidateFromAttentionItem`
   returns null for it). So the duplicates in focus were MENTION + RISK + ASSIGNMENT +
   DEPENDENCY on one ticket, and STALE appeared as one more separate card on Attention.
5. **"Action sets differ per surface."** Confirmed. Corrections:
   - Your Delivery Focus also shows **Start Focus**, not just Skip.
   - Block exists on every `TaskReferenceRow` surface: My Assigned Work, Daily Review,
     Action Plan ticket line and related-ticket blocks.
   - Priorities has Skip/Reactivate but no Block/Done/Unblock.
   - Attention has none of them.
   - My Day has Defer, which no other surface has.

Additional divergences found during the audit:

- **Two incompatible "skip/block" vocabularies.** The Focus Session block reasons
  (`"Waiting on someone else"`, …) and the Daily Command `BLOCK_REASON_SUGGESTIONS` are
  different lists.
- **No ticket key on Focus events.** `FOCUS_COMPLETED` memory events carry no `ticketKey`,
  so a ticket finished from Focus Session would appear in the Daily Report only as a
  keyless line — or twice, once a ticket-level event was also emitted.
- **DEFERRED and IN_PROGRESS existed only on plan items and actions.** No ticket-level
  equivalent existed.

---

## Part 2 — The model after the change

### 2.1 One canonical per-ticket state

`StoreState.ticketWorkStates: Record<ticketKey, TicketWorkState>`, defined in `types.ts`
and handled in `ticket-work-state.ts`.

```ts
{ ticketKey, status: "TODO"|"IN_PROGRESS"|"BLOCKED"|"SKIPPED"|"DEFERRED"|"DONE",
  reason?, until?, updatedAt, updatedBy?, history: [{ from, to, at, reason?, surface }] /* last 50 */,
  pingOn?, source?: "user"|"jira", closedInJiraOn? }
```

- **TODO is implicit.** A missing record means TODO. A record is kept with status `TODO`
  only after a ticket returns to TODO, so its history survives and the record acts as the
  cross-device "removed" marker.
- **Jira status is a read-only overlay.** `getTicketView(...).jiraStatus` and `relevance`
  show it beside the personal status. It is never written into `status`.
- **The only write path** is `store.setTicketStatus(ticketKey, status, { reason, until,
  surface, pingOn })`. Every other ticket mutation is a thin wrapper around it:
  `completeTicketInDailyCommand`, `skip…`, `block…`, `reopen…`, `reactivate…`, `unblock…`,
  `startTicket`, `stopTicket` and `deferTicket`. The only automatic write is a Jira sync
  closing a skipped, blocked or deferred ticket, which goes through the same pure
  `applyTicketStatus` (source `jira`).
- **Plan items and focus.**
  - `startFocusItem`, `completeFocusItem`, `blockFocusItem` and `skipFocusItem` route
    through `setTicketStatus` when the plan item has a ticket. If the table rejects the
    transition, nothing changes.
  - `deferPersonalPlanItem` defers the ticket: until a given date, by default tomorrow.
  - Action Plan's "Complete action" on a ticket-backed candidate also sets the ticket DONE.

### 2.2 Transition table

There are two rules. Every pair is tested in `scripts/tests/`, group
`[TicketWorkState]`.

- From any status **other than DONE**, every target is allowed. Same-status writes update
  the reason or date and append history; TODO→TODO is a no-op.
- From **DONE**, only `TODO` (Reopen) is allowed. DONE→DONE is a no-op; every other target
  is rejected.

| from \ to | TODO | IN_PROGRESS | BLOCKED | SKIPPED | DEFERRED | DONE |
|---|---|---|---|---|---|---|
| TODO | no-op | ✔ | ✔ | ✔ | ✔ | ✔ |
| IN_PROGRESS | ✔ (stop) | ✔ (update) | ✔ | ✔ | ✔ | ✔ |
| BLOCKED | ✔ Unblock | ✔ | ✔ (update) | ✔ | ✔ | ✔ |
| SKIPPED | ✔ Reactivate | ✔ | ✔ | ✔ (update) | ✔ | ✔ |
| DEFERRED | ✔ Reactivate | ✔ | ✔ | ✔ | ✔ (update) | ✔ |
| DONE | ✔ **Reopen only** | ✘ | ✘ | ✘ | ✘ | no-op |

Each transition does three things in **one** `set()`:

1. **Updates linked records.** These are plan items whose `ticketKey` matches, open actions
   whose `relatedWorkItemId` resolves to the ticket, and open attention items whose
   `ticketKey` matches.

   | → | linked plan items | linked open actions | open attention items |
   |---|---|---|---|
   | DONE | completed | completed | resolved |
   | BLOCKED | blocked, same reason (no auto Follow-up Action) | — | — |
   | SKIPPED / DEFERRED | skipped / deferred | — | — |
   | IN_PROGRESS | in-progress | — | — |
   | TODO | back to `planned` if dated today or later | from DONE (Reopen): the most recently completed one reopens | — |

   "Linked plan items" means items whose `ticketKey` (or resolvable attention source)
   matches, and which are still open or dated today or later. A finished plan item from a
   past day is history and is never rewritten. The attention items resolved on DONE are
   those named after the ticket (`MENTION:<key>:…`, `ASSIGNMENT:` / `STALE:<work item>`, or
   `ACTION:` for a linked action).

2. **Records a memory event:** `TICKET_COMPLETED`, `TICKET_SKIPPED`, `TICKET_BLOCKED`,
   `TICKET_DEFERRED` or `TICKET_STARTED`. Going back to TODO records `TICKET_REOPENED` (from
   DONE or IN_PROGRESS), `TICKET_UNBLOCKED` (from BLOCKED) or `TICKET_REACTIVATED` (from
   SKIPPED or DEFERRED).
3. **Updates the derived legacy maps.** See 2.3.

### 2.3 Migration and legacy maps

- **Migration (`migrateLegacyIntoTicketStates`).** It runs on every parse, on cross-tab
  rebase and on cross-device sync, and is idempotent. It maps:
  - `dailyCommandCompletions` → DONE
  - `dailyCommandSkips` → SKIPPED
  - `dailyCommandBlocks` → BLOCKED

  It also maps ticket-linked plan items with status completed / blocked / skipped /
  in-progress / deferred. A legacy record overrides an existing ticket state only when its
  own clock is **strictly newer**. A legacy tombstone newer than the ticket state turns it
  back to TODO; this is how an older-version device's Reopen is honoured. Nothing is ever
  deleted.
- **Derived legacy maps (deprecated).** `dailyCommandCompletions`, `Skips`, `Blocks` and
  `Tombstones` are still in `StoreState` and in the synced blob for one version. They are
  rebuilt from `ticketWorkStates` by `ticketStateMaps()` inside every write, so code or an
  older device that still reads them sees the same truth:
  - DEFERRED projects as a skip with `revisitOn = until`.
  - IN_PROGRESS and TODO project as absent.
- **Today-aware projection.** Engines that still take map-shaped input get it from
  `selectDailyCommandMaps(state, today)`. That projection also drops a DEFERRED ticket whose
  `until` has arrived, so it comes back into Today on its date.
- **Cross-device merge.** `mergeTicketWorkStates` keeps the newer `updatedAt` per ticket,
  with a deterministic tie-break. It runs before migrating the other side's legacy maps.

### 2.4 One selector, one bucket

`getTicketView(ticketKey, ctx)` → `{ status, reason, until, since, jiraStatus, relevance,
isNew, newReason, reactivation, signals[] }`.

`ticketBucket(view, today)` puts every ticket in **exactly one** bucket:

| Bucket | Rule |
|---|---|
| `TODAY` | TODO, or DEFERRED with `until ≤ today` |
| `IN_PROGRESS` | IN_PROGRESS |
| `BLOCKED` | BLOCKED |
| `SKIPPED_DEFERRED` | SKIPPED, or DEFERRED with `until > today` (or no date) |
| `DONE` | DONE |

The engines' exclusion sets all come from `ticketExclusionSets(ticketWorkStates, workItems,
today)`, built once in `use-command-center.ts` and in `buildProjectOverrideView`:

- `doneIds` = DONE
- `pausedIds` = BLOCKED ∪ SKIPPED ∪ DEFERRED-until-future

### 2.5 Surface → selector map

| Surface | Population | Per-row status |
|---|---|---|
| My Work (`/my-work`, all views) | `buildMyWork()` (`my-work.ts`) over assigned work + deduped focus candidates + ticket states + Daily Review New | `getTicketView` |
| Command Center → My Work summary | `buildMyWork()` counts + top items | `getTicketView` |
| Your Delivery Focus (My Work → Today) | `computePersonalFocus` (excludes `doneIds`/`pausedIds`), **deduped by ticketKey**: one row per ticket, one chip per signal kind ("Risk ×2"), ranked by its highest signal. STALE stays Attention-only, but My Work rows also carry attention chips, so Mention + Stale + Risk show on one row | `getTicketView` via `TaskRow` |
| My Day agenda (`/my-work?view=today`; `/focus` redirects here) | `personalPlan` today, joined to deduped candidates by source, merged signal or ticket (`candidateFor`); a row with a `ticketKey` takes its status from the ticket (`effectivePlanStatus`) | `TaskRow` (ticket rows), plan status (ticketless rows, same labels) |
| Focus Session | candidate / plan item | read-only `TaskRow` header; Complete / Blocked / Skip / (auto) Start call `setTicketStatus` through the store's focus methods |
| Daily Review (`/daily-review` → `/my-work?view=new`) | `buildDailyReview(selectDailyCommandMaps(...))`; New rows in the New view, re-checks as pointers, follow-ups in the Blocked view, completions in Done | `TaskRow` |
| Priorities | `derived.scores`; SKIPPED/BLOCKED tabs from `pausedIds` split by status | `getTicketView` via `TaskRow` |
| Action Plan | `buildPlan(…, doneIds, pausedIds)` | ticket line `TaskRow`; Action Plan "Complete action" also sets DONE on the ticket |
| Attention | `proactive.attentionQueue` | each card with a `ticketKey` shows a `TaskRow` with the ticket's status; "Resolve as done" → `setTicketStatus(DONE)` |
| Recently Mentioned, Reports, Morning brief, Follow-ups | `selectDailyCommandMaps(state, today)` | — |

### 2.6 TaskRow and documented action-hiding props

`TaskRow` (`TaskReferenceRow.tsx`) is the single row used everywhere. It always offers:

- **Open in Jira · Start · Done · Block (+reason) · Skip (+reason) · Defer (+date)**
- plus **Reopen / Unblock / Reactivate / Stop** when they apply.

A surface may hide actions **only** through these props:

| Prop | Effect | Used by |
|---|---|---|
| `readOnly` | no buttons at all (status, since, reason and Jira overlay only) | Focus Session header — the session's own Complete / Blocked / Skip buttons are the ticket actions and go through `setTicketStatus` |
| `hideActions={[...]}` | hides only the listed actions (`open`, `start`, `done`, `block`, `skip`, `defer`) | available; no surface uses it today |
| `ticketScoped` | relabels buttons "… ticket" (no hiding) | Action Plan rows, which also carry action-level buttons |

A ticket that Jira finished, with no personal record, renders read-only ("Done in Jira").
That is a status rule, not a per-surface choice.

Every other placement of `TaskRow` shows the full set.
