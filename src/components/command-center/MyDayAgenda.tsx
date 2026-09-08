"use client";

// "MY DAY" (V1.6 §11-15, §33-35, §49-52; V1.7 §16-23). Reconciles the persisted
// PersonalPlanItem[] against live PersonalFocusCandidate[] — never a second task database
// (§12): every row here is a reference joined back to its live source at render time.

import { useMemo, useState } from "react";
import { reconcilePersonalPlan, detectNewCriticalArrivals, buildCarryForward, buildSuggestedDailyPlan } from "@/lib/command-center/personal-plan";
import type { FocusCategory, PersonalFocusCandidate, PersonalFocusResult, PersonalPlanItem, PlanItemOrigin } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { FocusSession } from "./FocusSession";
import { isMyActionItem } from "@/lib/command-center/personal-relation";
import { FocusCategoryBadge, Panel, RelationBadge, SectionHeading, TrustLabel } from "./ui";

const SECTIONS: { category: FocusCategory; title: string }[] = [
  { category: "DO_NOW", title: "Do Now" },
  { category: "DO_TODAY", title: "Do Today" },
  { category: "WATCH", title: "Watch" },
  { category: "BLOCKED", title: "Blocked" },
];

const ORIGIN_LABELS: Record<PlanItemOrigin, string> = {
  "system-suggested": "Suggested",
  "user-added": "Added by you",
  "carried-forward": "Carried forward",
};

// V2.0 §15 — every plan row should be able to answer "Why is this still on my plan?"
// without opening anything else. Pure mapping over data the row already has — pinned and
// reconciliation-review status take priority since they're the most specific reasons.
function whyStillOnPlan(item: PersonalPlanItem, hasReviewFlag: boolean): string {
  if (item.pinned) return "Explicitly pinned.";
  if (hasReviewFlag) return "Needs review — see note above.";
  if (item.origin === "carried-forward") return "Carried forward from yesterday.";
  if (item.origin === "user-added") return "Added by you.";
  if (item.origin === "system-suggested") return "Still high priority based on current evidence.";
  return "Still unresolved.";
}

function PlanRow({
  item,
  candidate,
  hasReviewFlag,
  onStartFocus,
  onMove,
  onRemove,
  onDefer,
  onTogglePin,
  onDragStart,
  onDragOver,
  onDrop,
  draggable,
}: {
  item: PersonalPlanItem;
  candidate: PersonalFocusCandidate | undefined;
  hasReviewFlag?: boolean;
  onStartFocus: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDefer: () => void;
  onTogglePin?: () => void;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  draggable?: boolean;
}) {
  if (!candidate) {
    return (
      <Panel className="p-3 text-sm text-text3">
        {item.sourceType}:{item.sourceId} — no longer active (resolved elsewhere).
        <button onClick={onRemove} className="ml-2 text-xs font-medium text-accent2 hover:underline">
          Remove
        </button>
      </Panel>
    );
  }
  return (
    <Panel className="p-3" draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} aria-roledescription={draggable ? "Draggable focus item" : undefined}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <FocusCategoryBadge category={candidate.category} />
            <RelationBadge relation={candidate.relation} />
            {item.pinned && <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent2">Pinned</span>}
            {candidate.projectName && <span className="text-xs text-text3">{candidate.projectName}</span>}
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{item.status}</span>
            {item.origin && <span className="text-[10px] text-text3">{ORIGIN_LABELS[item.origin]}</span>}
          </div>
          <p className="font-display text-sm text-text">{candidate.title}</p>
          <p className="mt-0.5 text-xs text-text2">{candidate.nowWhat}</p>
          <p className="mt-0.5 text-xs text-text3">
            Source: {item.sourceType} · {candidate.estimatedMinutes}m
          </p>
          <p className="mt-0.5 text-xs text-text3">Why on plan: {whyStillOnPlan(item, !!hasReviewFlag)}</p>
          {item.status === "blocked" && item.blockedReason && (
            <p className="mt-0.5 text-xs text-red">Blocked: {item.blockedReason}{item.blockedNote ? ` — ${item.blockedNote}` : ""}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-xs">
          <div className="flex gap-1" role="group" aria-label="Reorder">
            <button onClick={() => onMove(-1)} className="rounded border border-border px-1.5 py-0.5 text-text3 hover:text-text" aria-label="Move up in today's order">
              ↑
            </button>
            <button onClick={() => onMove(1)} className="rounded border border-border px-1.5 py-0.5 text-text3 hover:text-text" aria-label="Move down in today's order">
              ↓
            </button>
          </div>
          {onTogglePin && (
            <button onClick={onTogglePin} className={`rounded border px-1.5 py-0.5 ${item.pinned ? "border-accent/30 text-accent2" : "border-border text-text3 hover:text-text"}`} aria-pressed={!!item.pinned}>
              {item.pinned ? "Unpin" : "Pin to top"}
            </button>
          )}
        </div>
      </div>
      {item.status !== "completed" && item.status !== "skipped" && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-2 text-xs">
          <button onClick={onStartFocus} className="rounded bg-accent px-2 py-1 font-medium text-white hover:bg-accent2">
            Start Focus
          </button>
          <button onClick={onDefer} className="rounded border border-border px-2 py-1 text-text2 hover:border-yellow hover:text-yellow">
            Defer
          </button>
          <button onClick={onRemove} className="rounded border border-border px-2 py-1 text-text2 hover:border-red hover:text-red">
            Remove
          </button>
        </div>
      )}
    </Panel>
  );
}

export function MyDayAgenda({ personalFocus }: { personalFocus: PersonalFocusResult }) {
  const { state, today, filteredData, store } = useCommandCenter();
  const [session, setSession] = useState<{ candidate: PersonalFocusCandidate; planItemId: string } | null>(null);
  const [reviewingUpdate, setReviewingUpdate] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // V2.14 §4 — a display-only filter applied where rows/sections are actually rendered
  // below, never fed into reconcilePersonalPlan/detectNewCriticalArrivals/buildCarryForward:
  // those need the TRUE full candidate set to correctly decide "is this plan item still
  // valid" — filtering their input would make a hidden-but-still-valid item look resolved.
  const myActionItemsOnly = state.myActionItemsOnly.myDay;

  const todayItems = useMemo(() => state.personalPlan.filter((p) => p.plannedDate === today).sort((a, b) => a.position - b.position), [state.personalPlan, today]);
  const activeToday = todayItems.filter((p) => p.status === "planned" || p.status === "in-progress" || p.status === "blocked");
  const doneToday = todayItems.filter((p) => p.status === "completed");

  const reconciliation = useMemo(() => reconcilePersonalPlan(todayItems, personalFocus.candidates, filteredData, today), [todayItems, personalFocus.candidates, filteredData, today]);
  const removeReasons = reconciliation.filter((r) => r.action === "REMOVE");
  const reviewReasons = reconciliation.filter((r) => r.action === "REVIEW" && !r.pinnedNeedsReview);
  const pinnedNeedsReview = reconciliation.filter((r) => r.pinnedNeedsReview);

  const newCritical = useMemo(() => detectNewCriticalArrivals(personalFocus.candidates, state.personalPlan), [personalFocus.candidates, state.personalPlan]);
  const carryForward = useMemo(() => buildCarryForward(state.personalPlan, personalFocus.candidates, today), [state.personalPlan, personalFocus.candidates, today]);

  function candidateForItem(item: PersonalPlanItem): PersonalFocusCandidate | undefined {
    return personalFocus.candidates.find((c) => c.sourceType === item.sourceType && c.sourceId === item.sourceId);
  }

  function startFocus(item: PersonalPlanItem, candidate: PersonalFocusCandidate) {
    setSession({ candidate, planItemId: item.id });
  }

  function move(item: PersonalPlanItem, dir: -1 | 1) {
    const ordered = [...activeToday].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex((p) => p.id === item.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;
    const next = [...ordered];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    store.reorderPersonalPlan(today, next.map((p) => p.id));
  }

  // V1.7 §16 — native HTML5 drag-and-drop, zero new dependencies. The ↑/↓ buttons above
  // remain the keyboard-accessible, mobile-safe alternative/fallback — this is a progressive
  // enhancement layered on top of them, not a replacement.
  function dropOnto(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ordered = [...activeToday].sort((a, b) => a.position - b.position);
    const fromIdx = ordered.findIndex((p) => p.id === dragId);
    const toIdx = ordered.findIndex((p) => p.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...ordered];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    store.reorderPersonalPlan(today, next.map((p) => p.id));
    setDragId(null);
  }

  const hasPlanToday = todayItems.length > 0;
  const suggestedAll = useMemo(() => buildSuggestedDailyPlan(personalFocus.candidates), [personalFocus.candidates]);
  // V2.14 §4 — narrows the already-computed suggestion, never re-selects a different one;
  // "Accept Plan" below accepts exactly what's shown, so the two never disagree.
  const suggested = myActionItemsOnly ? suggestedAll.filter((c) => isMyActionItem(c.relation)) : suggestedAll;
  const deadlineConflict = personalFocus.deadlineConflict;

  return (
    <div className="space-y-4">
      {deadlineConflict && !deadlineConflict.insufficientEvidence && (
        <Panel className="border-red/30 p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-red">Deadline Conflict</span>
          </div>
          <p className="text-sm text-text2">{deadlineConflict.reason}</p>
          <p className="mt-1 text-xs text-text3">
            Estimated focus: {deadlineConflict.totalEstimatedMinutes}m · Available budget: {deadlineConflict.availableBudgetMinutes}m
          </p>
          <p className="mt-1 text-xs font-medium text-text2">Now what: {deadlineConflict.nowWhat}</p>
        </Panel>
      )}

      {newCritical.length > 0 && (
        <Panel className="border-red/30 p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-red">Plan Updated</span>
          </div>
          <p className="text-sm text-text2">{newCritical.length} new critical item(s) detected.</p>
          {!reviewingUpdate ? (
            <button onClick={() => setReviewingUpdate(true)} className="mt-2 rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
              Review Update
            </button>
          ) : (
            <ul className="mt-2 space-y-1">
              {newCritical.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 text-xs text-text2">
                  <span>{c.title}</span>
                  <button
                    onClick={() =>
                      store.addPersonalPlanItem({
                        sourceType: c.sourceType,
                        sourceId: c.sourceId,
                        estimatedMinutes: c.estimatedMinutes,
                        plannedDate: today,
                        priority: 0,
                        snapshot: { category: c.category, projectId: c.projectId, ownershipExplicit: c.ownershipExplicit },
                      })
                    }
                    className="rounded border border-border px-2 py-0.5 text-text2 hover:border-accent hover:text-text"
                  >
                    Add to Today
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {carryForward.length > 0 && (
        <Panel className="p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-text3">Carry Forward</span>
          </div>
          <p className="text-sm text-text2">{carryForward.length} unfinished item(s) remain relevant.</p>
          <ul className="mt-2 space-y-1">
            {carryForward.map((s) => (
              <li key={s.planItem.id} className="flex items-center justify-between gap-2 text-xs text-text2">
                <span>
                  {s.candidate.title} — {s.reason}
                </span>
                <button onClick={() => store.carryForwardPersonalPlanItem(s.planItem, today)} className="rounded border border-border px-2 py-0.5 text-text2 hover:border-accent hover:text-text">
                  Add to Today
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(removeReasons.length > 0 || reviewReasons.length > 0 || pinnedNeedsReview.length > 0) && (
        <Panel className="p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-text3">Why Did My Plan Change?</span>
          </div>

          {pinnedNeedsReview.length > 0 && (
            <ul className="mt-2 space-y-2">
              {pinnedNeedsReview.map((r) => (
                <li key={r.planItemId} className="rounded-md border border-accent/30 bg-accent/5 p-2 text-xs text-text2">
                  <p>{r.reason}</p>
                  <div className="mt-1 flex gap-2">
                    <button onClick={() => store.removePersonalPlanItem(r.planItemId)} className="rounded border border-border px-2 py-0.5 text-text2 hover:border-red hover:text-red">
                      Remove
                    </button>
                    <button onClick={() => store.unpinPersonalPlanItem(r.planItemId)} className="rounded border border-border px-2 py-0.5 text-text2 hover:border-accent hover:text-text">
                      Keep Anyway
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {reviewReasons.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-orange">
              {reviewReasons.map((r) => (
                <li key={r.planItemId}>{r.reason}</li>
              ))}
            </ul>
          )}

          {removeReasons.length > 0 && (
            <>
              <ul className="mt-2 space-y-0.5 text-xs text-text2">
                {removeReasons.map((r) => (
                  <li key={r.planItemId}>{r.reason}</li>
                ))}
              </ul>
              <button
                onClick={() => removeReasons.forEach((r) => store.removePersonalPlanItem(r.planItemId))}
                className="mt-2 rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text"
              >
                Clean Up ({removeReasons.length})
              </button>
            </>
          )}
        </Panel>
      )}

      {!hasPlanToday ? (
        <Panel className="p-5">
          <SectionHeading title="Suggested Plan" subtitle="Deterministic — DO NOW items first, then DO TODAY." />
          {suggested.length === 0 ? (
            <p className="text-sm text-text3">Nothing needs a plan today.</p>
          ) : (
            <>
              <ol className="space-y-1 text-sm text-text2">
                {suggested.map((c, i) => (
                  <li key={c.id}>
                    {i + 1}. {c.title} ({c.estimatedMinutes}m)
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex gap-2">
                <button onClick={() => store.acceptSuggestedPlan(suggested, today)} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent2">
                  Accept Plan
                </button>
              </div>
            </>
          )}
        </Panel>
      ) : (
        <div className="flex justify-end">
          <button onClick={() => store.resetPersonalPlanForToday(today)} className="rounded-md border border-border px-3 py-1.5 text-xs text-text2 hover:border-red hover:text-red">
            Reset Plan
          </button>
        </div>
      )}

      {SECTIONS.map(({ category, title }) => {
        const items = activeToday.filter((item) => {
          const candidate = candidateForItem(item);
          const effectiveCategory = item.status === "blocked" ? "BLOCKED" : candidate?.category;
          if (effectiveCategory !== category) return false;
          // V2.14 §4 — hides the row, never touches candidateForItem/reconciliation above.
          if (myActionItemsOnly && !isMyActionItem(candidate?.relation)) return false;
          return true;
        });
        if (items.length === 0) return null;
        return (
          <section key={category}>
            <SectionHeading title={title} />
            <div className="space-y-2">
              {items.map((item) => {
                const candidate = candidateForItem(item);
                const reviewFlag = reviewReasons.find((r) => r.planItemId === item.id);
                return (
                  <div key={item.id}>
                    {reviewFlag && <p className="mb-1 text-xs text-orange">Review: {reviewFlag.reason}</p>}
                    <PlanRow
                      item={item}
                      candidate={candidate}
                      hasReviewFlag={!!reviewFlag}
                      onStartFocus={() => candidate && startFocus(item, candidate)}
                      onMove={(dir) => move(item, dir)}
                      onRemove={() => store.removePersonalPlanItem(item.id)}
                      onDefer={() => store.deferPersonalPlanItem(item.id)}
                      onTogglePin={() => (item.pinned ? store.unpinPersonalPlanItem(item.id) : store.pinPersonalPlanItem(item.id))}
                      draggable
                      onDragStart={() => setDragId(item.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => dropOnto(item.id)}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {doneToday.length > 0 && (
        <section>
          <SectionHeading title="Done" />
          <div className="space-y-2">
            {doneToday.map((item) => {
              const candidate = candidateForItem(item);
              return <PlanRow key={item.id} item={item} candidate={candidate} onStartFocus={() => {}} onMove={() => {}} onRemove={() => store.removePersonalPlanItem(item.id)} onDefer={() => {}} />;
            })}
          </div>
        </section>
      )}

      {session && <FocusSession candidate={session.candidate} planItemId={session.planItemId} onClose={() => setSession(null)} />}
    </div>
  );
}
