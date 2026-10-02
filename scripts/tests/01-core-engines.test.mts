// Core deterministic engines: scoring, risk, change detection, action plan, import, demo data
// Run through scripts/tests/run.mts (npm test).

import { scoreWorkItem, isOverdue, daysBetween, classify, eligibilityScore } from "../../src/lib/command-center/scoring";
import { detectRisks } from "../../src/lib/command-center/risk-detection";
import { detectChanges, toSnapshot } from "../../src/lib/command-center/change-detection";
import { buildCandidates, buildPlan } from "../../src/lib/command-center/action-plan";
import { importFromJson, importFromCsv, importFromText } from "../../src/lib/command-center/import";
import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { TODAY, makeItem } from "./helpers.mts";

// ===== Priority scoring =====
{
  const critical = makeItem({
    id: "crit", businessImpact: 5, dueDate: TODAY, blocked: true, blockerReason: "x",
    owner: undefined, scopeChangeCount: 5, lastUpdated: "2026-06-01",
  });
  const low = makeItem({ id: "low", businessImpact: 1, dueDate: "2026-08-01", owner: "Bob" });
  const data = { ...emptyData(), workItems: [critical, low] };

  const criticalResult = scoreWorkItem(critical, data, TODAY);
  const lowResult = scoreWorkItem(low, data, TODAY);

  ok("Priority scoring", criticalResult.score > lowResult.score, `critical item outranks low-risk item (${criticalResult.score} > ${lowResult.score})`);
  ok("Priority scoring", criticalResult.classification === "CRITICAL", `high-risk combination classifies as CRITICAL (got ${criticalResult.classification})`);
  ok("Priority scoring", lowResult.classification === "LOW" || lowResult.classification === "MEDIUM", `low-risk item does not classify as CRITICAL (got ${lowResult.classification})`);
  ok("Priority scoring", classify(85) === "CRITICAL" && classify(65) === "HIGH" && classify(45) === "MEDIUM" && classify(10) === "LOW", "classify() thresholds match spec (80/60/40)");
  ok("Priority scoring", criticalResult.factors.reduce((s, f) => s + f.max, 0) === 100, "factor weights sum to 100");
}


// ===== Overdue detection =====
{
  const overdue = makeItem({ dueDate: "2026-06-10" }); // 5 days before TODAY
  const notYet = makeItem({ dueDate: "2026-06-20" });
  const done = makeItem({ dueDate: "2026-06-01", status: "Done" });
  ok("Overdue detection", isOverdue(overdue, TODAY) === true, "past due date with open status is overdue");
  ok("Overdue detection", isOverdue(notYet, TODAY) === false, "future due date is not overdue");
  ok("Overdue detection", isOverdue(done, TODAY) === false, "Done items are never overdue regardless of due date");
}


// ===== Aging calculation =====
{
  ok("Aging calculation", daysBetween("2026-06-01", "2026-06-15") === 14, "daysBetween computes correct day count");
  const staleItem = makeItem({ lastUpdated: "2026-06-01" });
  const freshItem = makeItem({ lastUpdated: TODAY });
  const data = { ...emptyData(), workItems: [staleItem, freshItem] };
  const staleScore = scoreWorkItem(staleItem, data, TODAY);
  const freshScore = scoreWorkItem(freshItem, data, TODAY);
  const agingFactor = (r: typeof staleScore) => r.factors.find((f) => f.name === "Aging")!.contribution;
  ok("Aging calculation", agingFactor(staleScore) > agingFactor(freshScore), "stale item accrues more aging score than a freshly updated one");
}


// ===== Risk scoring =====
{
  const blockedWithDep = makeItem({
    id: "blocked-1", blocked: true, blockerReason: "waiting", dependencyIds: ["dep-1"],
  });
  const data = {
    ...emptyData(),
    workItems: [blockedWithDep],
    dependencies: [{ id: "dep-1", workItemId: "blocked-1", description: "x", dependsOnTeam: "Eng", status: "unresolved" as const, raisedDate: TODAY }],
  };
  const risks = detectRisks(data, TODAY);
  ok("Risk scoring", risks.some((r) => r.level === "HIGH"), "blocked item + unresolved dependency produces a HIGH risk");
  ok("Risk scoring", risks.every((r) => r.evidence.length > 0), "every detected risk carries evidence");

  const noOwnerHighPriority = makeItem({ id: "no-owner", priority: "P1", owner: undefined });
  const risks2 = detectRisks({ ...emptyData(), workItems: [noOwnerHighPriority] }, TODAY);
  ok("Risk scoring", risks2.some((r) => r.title.includes("no owner")), "P1 item with no owner is flagged");
}


// ===== Change detection =====
{
  const before = makeItem({ status: "Not Started", priority: "P3" });
  const after = makeItem({ status: "Blocked", priority: "P1" });
  const previous = toSnapshot({ ...emptyData(), workItems: [before] }, "2026-06-14");
  const current = { ...emptyData(), workItems: [after] };
  const changes = detectChanges(previous, current, TODAY);
  ok("Change detection", changes.some((c) => c.field === "Status"), "status change is detected");
  ok("Change detection", changes.some((c) => c.field === "Priority"), "priority change is detected");

  const unchanged = toSnapshot({ ...emptyData(), workItems: [before] }, "2026-06-14");
  const noChanges = detectChanges(unchanged, { ...emptyData(), workItems: [before] }, TODAY);
  ok("Change detection", noChanges.length === 0, "identical data produces zero change events (no noise)");

  const noSnapshot = detectChanges(null, current, TODAY);
  ok("Change detection", noSnapshot.length === 0, "no previous snapshot yields no changes rather than crashing");
}


// ===== Action-plan generation =====
{
  const { current } = buildDemoData(TODAY);
  const plan15 = buildPlan(current, TODAY, 15);
  const plan480 = buildPlan(current, TODAY, 480);
  const sum = (items: { estimateMinutes: number }[]) => items.reduce((s, i) => s + i.estimateMinutes, 0);
  ok("Action plan", sum(plan15) <= 15, `15-minute plan respects its budget (used ${sum(plan15)} min)`);
  ok("Action plan", plan480.length >= plan15.length, "a full-day plan includes at least as many items as a 15-minute plan");
  ok("Action plan", plan15.every((c, i, arr) => i === 0 || arr[i - 1].priorityScore >= c.priorityScore), "plan items are ordered by descending priority score");
}


// ===== BUGFIX regression — completing (or deferring/snoozing/blocking) an auto-suggested
// candidate's Action must never make that same WorkItem reappear as a fresh, untouched
// candidate on the next recompute. Previously buildCandidates() only excluded items covered
// by an OPEN action, so completing an action removed it from coveredItemIds and the item
// came right back via the bare-item loop — visually indistinguishable from never having
// been touched (most visible after a page reload, since the client-side liveAction
// workaround in action-plan/page.tsx only survives within one still-mounted component). =====
{
  const highScoreItem = makeItem({ id: "bugfix-1", key: "BUG-1", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const dataNoAction = { ...emptyData(), workItems: [highScoreItem] };
  const beforeAny = buildCandidates(dataNoAction, TODAY);
  ok("Action plan bugfix", beforeAny.some((c) => c.item?.id === "bugfix-1" && c.id === "plan-bugfix-1"), "sanity check: a fresh, untouched high-scoring item is auto-suggested as a bare-item candidate");

  for (const status of ["completed", "deferred", "snoozed", "blocked"] as const) {
    const action = { id: `bugfix-action-${status}`, title: "Do the thing", why: "test", relatedWorkItemId: "bugfix-1", status, estimateMinutes: 15, createdAt: TODAY, ...(status === "completed" ? { completedAt: TODAY } : {}) };
    const dataAfter = { ...emptyData(), workItems: [highScoreItem], actions: [action] };
    const after = buildCandidates(dataAfter, TODAY);
    ok(
      "Action plan bugfix",
      !after.some((c) => c.id === "plan-bugfix-1"),
      `a ${status} Action's WorkItem is never re-synthesized as a fresh bare-item candidate (would silently look untouched again)`
    );
  }

  // The "open" case is the control: an item with an OPEN action must still be represented
  // (via the action-based candidate itself) — the fix must not hide active work.
  const openAction = { id: "bugfix-action-open", title: "Do the thing", why: "test", relatedWorkItemId: "bugfix-1", status: "open" as const, estimateMinutes: 15, createdAt: TODAY };
  const dataOpen = { ...emptyData(), workItems: [highScoreItem], actions: [openAction] };
  const withOpen = buildCandidates(dataOpen, TODAY);
  ok("Action plan bugfix", withOpen.some((c) => c.id === "bugfix-action-open"), "an item with an OPEN action remains represented via its own action-based candidate, never hidden");
  ok("Action plan bugfix", !withOpen.some((c) => c.id === "plan-bugfix-1"), "…and is never ALSO duplicated as a second, bare-item candidate for the same WorkItem");
}


// ===== V2.9 §F-01 fix — eligibilityScore must not punish missing Business Impact /
// due-date data (the real-Jira norm) out of candidacy, while still excluding genuinely
// quiet items. Reproduces the real-world shape found auditing a live Jira instance:
// a heavily-churned, blocked item scored 25/100 raw (well under the old flat 40 gate)
// purely because it had no Business Impact field or due date populated. =====
{
  const noBusinessImpactOrDueDate = { businessImpact: undefined, dueDate: undefined } as const;
  const churnedAndBlocked = makeItem({ id: "churned-1", blocked: true, scopeChangeCount: 21, ...noBusinessImpactOrDueDate });
  const churnedResult = scoreWorkItem(churnedAndBlocked, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", churnedResult.score < 40, `sanity check: raw score (${churnedResult.score}) is below the old flat 40 gate, exactly like the real audited item`);
  ok("V2.9 Eligibility fix", eligibilityScore(churnedAndBlocked, churnedResult) >= 40, `a heavily-churned, blocked item now clears the candidate gate (eligibilityScore ${eligibilityScore(churnedAndBlocked, churnedResult)}) despite missing Business Impact/due date`);

  const quietItem = makeItem({ id: "quiet-1", blocked: false, scopeChangeCount: 0, lastUpdated: TODAY, ...noBusinessImpactOrDueDate });
  const quietResult = scoreWorkItem(quietItem, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", eligibilityScore(quietItem, quietResult) < 40, "a genuinely low-signal item with the same missing fields is still correctly excluded — the fix removes an unfair penalty, not the bar itself");

  const fullyPopulated = makeItem({ id: "full-1", blocked: true, scopeChangeCount: 21, businessImpact: 3, dueDate: TODAY });
  const fullResult = scoreWorkItem(fullyPopulated, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", eligibilityScore(fullyPopulated, fullResult) === fullResult.score, "an item with both fields populated is completely unaffected — eligibilityScore only adjusts for missing data");

  const candidates = buildCandidates({ ...emptyData(), workItems: [churnedAndBlocked, quietItem] }, TODAY);
  const candidateIds = new Set(candidates.map((c) => c.item?.id).filter(Boolean));
  ok("V2.9 Eligibility fix", candidateIds.has("churned-1"), "buildCandidates() end-to-end: the churned/blocked item is now a real candidate");
  ok("V2.9 Eligibility fix", !candidateIds.has("quiet-1"), "buildCandidates() end-to-end: the quiet item remains excluded, not flooded in");
}


// ===== Data import validation =====
{
  const good = importFromJson(JSON.stringify({ workItems: [{ key: "X-1", title: "Do a thing" }] }), TODAY);
  ok("Data import", good.ok === true, "valid minimal JSON import succeeds");
  ok("Data import", good.data.workItems[0].status === "Not Started", "missing fields fall back to sane defaults");

  const badJson = importFromJson("{not valid json", TODAY);
  ok("Data import", badJson.ok === false, "malformed JSON is rejected, not thrown");
  ok("Data import", badJson.errors.length > 0, "malformed JSON import reports an error message");

  const badShape = importFromJson(JSON.stringify({ workItems: [{ title: "missing key field" }] }), TODAY);
  ok("Data import", badShape.ok === false, "JSON missing a required field (key) is rejected");

  const csv = importFromCsv("key,title,priority\nX-2,Second thing,P1", TODAY);
  ok("Data import", csv.ok === true && csv.data.workItems.length === 1, "valid CSV import parses one row");

  const emptyCsv = importFromCsv("just one line, no data rows", TODAY);
  ok("Data import", emptyCsv.ok === false, "CSV without data rows is rejected gracefully");

  const text = importFromText("- Follow up with client\n- [ ] Chase QA sign-off\nnot a bullet, ignored", TODAY);
  ok("Data import", text.ok === true && text.data.workItems.length === 2, "pasted text extracts bullet/checklist lines only");

  const garbage = importFromText("no bullets here at all", TODAY);
  ok("Data import", garbage.ok === false, "pasted text with no list items does not crash and reports failure");
}


// ===== Empty state =====
{
  const data = emptyData();
  ok("Empty state", data.workItems.length === 0 && data.risks.length === 0, "emptyData() returns a fully-empty, valid dataset");
  const risks = detectRisks(data, TODAY);
  ok("Empty state", risks.length === 0, "risk detection on empty data returns no risks, does not throw");
  const plan = buildPlan(data, TODAY, 60);
  ok("Empty state", plan.length === 0, "action plan on empty data returns no candidates, does not throw");
}


// ===== Demo dataset =====
{
  const { snapshotHistory, current } = buildDemoData(TODAY);
  const previous = snapshotHistory[snapshotHistory.length - 1] ?? null;
  ok("Demo dataset", current.clients.length === 5, `demo includes 5 clients (got ${current.clients.length})`);
  ok("Demo dataset", current.workItems.length >= 10, `demo includes a realistic number of work items (got ${current.workItems.length})`);
  ok("Demo dataset", snapshotHistory.length >= 3, `demo seeds multiple days of history for trend/pattern features (got ${snapshotHistory.length})`);

  const changes = detectChanges(previous, current, TODAY);
  ok("Demo dataset", changes.length >= 4, `demo produces at least 4 meaningful changes out of the box (got ${changes.length})`);

  const risks = detectRisks(current, TODAY);
  ok("Demo dataset", risks.length >= 2, `demo produces at least 2 emerging risks (got ${risks.length})`);

  const criticalOrHigh = current.workItems
    .filter((w) => w.status !== "Done")
    .map((w) => scoreWorkItem(w, current, TODAY))
    .filter((r) => r.classification === "CRITICAL" || r.classification === "HIGH");
  ok("Demo dataset", criticalOrHigh.length >= 3, `demo surfaces at least 3 high-priority issues (got ${criticalOrHigh.length})`);

  ok("Demo dataset", current.communications.length >= 2, `demo includes at least 2 communication recommendations (got ${current.communications.length})`);
}
