// P3.1 — Priority Score v2: factors, boundaries, confidence, eligibility, model switch, snapshots, parsing, perf.
import { awaitingMeAgeBusinessDays, awaitingMePoints, buildAwaitingMe } from "../../src/lib/command-center/awaiting-me";
import { eligibilityScore, scoreAllWorkItems, scoreWorkItem, type ScoringOptions } from "../../src/lib/command-center/scoring";
import { eligibilityScoreV2, SCORE_V2_MAX } from "../../src/lib/command-center/scoring-v2";
import { deriveData } from "../../src/lib/command-center/selectors";
import { buildPlan } from "../../src/lib/command-center/action-plan";
import { buildSnapshotMetrics, compareSnapshots } from "../../src/lib/command-center/memory";
import { computeDeliveryDrift, computeTrajectory } from "../../src/lib/command-center/delivery-drift";
import { parseStoredState } from "../../src/lib/command-center/store";
import { normalizeIssues } from "../../src/lib/command-center/jira/normalize";
import { emptyData, type CommandCenterData, type Dependency, type MentionReply, type SnapshotMetrics, type WorkItem } from "../../src/lib/command-center/types";
import { buildPerfData } from "./perf-fixture.mts";
import { ok, perfBudget } from "./harness.mts";
import { makeJiraIssue } from "./helpers.mts";

const today = "2026-10-27"; // a Tuesday
const mk = (over: Partial<WorkItem> = {}): WorkItem =>
  ({ id: "jira-X-1", key: "X-1", title: "t", projectId: "p", clientId: "c", type: "task", status: "In Progress", priority: "P3", createdDate: "2026-10-01", lastUpdated: today, blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, owner: "Tay", ownerId: "acc-me", ...over }) as WorkItem;
const dataOf = (items: WorkItem[] = [], deps: Dependency[] = []): CommandCenterData => ({ ...emptyData(), workItems: items, dependencies: deps });
const v2: ScoringOptions = { model: "v2" };
const s2 = (over: Partial<WorkItem> = {}, opts: ScoringOptions = v2, deps: Dependency[] = []) => scoreWorkItem(mk(over), dataOf([], deps), today, opts);
const f = (r: ReturnType<typeof s2>, name: string) => r.factors.find((x) => x.name === name)!;

{
  const group = "P3.1 Default model is v1";
  const item = mk({ priority: "P1", dueDate: "2026-10-28", businessImpact: 4, lastUpdated: "2026-10-20" });
  const a = scoreWorkItem(item, dataOf(), today);
  const b = scoreWorkItem(item, dataOf(), today, { model: "v1" });
  ok(group, JSON.stringify(a) === JSON.stringify(b), "calls without a model and with model v1 give identical results");
  // hand-computed with the ORIGINAL formula: BI 4*4=16, due tomorrow 18, aging 7, no deps/block/changes, owned -> 41
  ok(group, a.score === 41 && a.factors.length === 7 && a.factors[0].max === 20, `v1 is unchanged (score ${a.score}, 7 factors)`);
  ok(group, eligibilityScore(item, a) === eligibilityScore(item, a, "v1"), "eligibilityScore defaults to v1");
}

{
  const group = "P3.1 v2 factors";
  ok(group, [["P1", 20], ["P2", 14], ["P3", 7], ["P4", 0]].every(([p, pts]) => f(s2({ priority: p as WorkItem["priority"] }), "Priority").contribution === pts), "Priority: P1 20 · P2 14 · P3 7 · P4 0");
  const known = s2({ priority: "P1", jiraPriorityName: "Highest", priorityKnown: true });
  ok(group, f(known, "Priority").detail === "Priority P1 (Highest in Jira)", "Priority detail names Jira's own word");
  const unknown = s2({ priority: "P3", priorityKnown: false });
  ok(group, f(unknown, "Priority").contribution === 0 && f(unknown, "Priority").detail === "Priority not set in Jira", "unknown Jira priority contributes 0 (mapPriority's P3 placeholder is not trusted)");
  ok(group, s2({ priorityKnown: false }).confidence === Math.round((s2({ priorityKnown: true }).confidence - 0.05) * 100) / 100, "…and lowers confidence by 0.05");

  // deadline: same boundaries as v1
  const dl = (due?: string) => f(s2({ dueDate: due }), "Deadline proximity").contribution;
  ok(group, dl("2026-10-20") === 20 && dl("2026-10-26") === 20 && dl(today) === 18 && dl("2026-10-28") === 18 && dl("2026-10-29") === 14 && dl("2026-10-30") === 14 && dl("2026-10-31") === 8 && dl("2026-11-03") === 8 && dl("2026-11-04") === 4 && dl("2026-11-10") === 4 && dl("2026-11-11") === 0 && dl(undefined) === 0, "Deadline boundaries match v1 (overdue 20, today/tomorrow 18, ≤3d 14, ≤7d 8, ≤14d 4, else 0, none 0)");
  ok(group, f(s2({ dueDate: "2026-10-24" }), "Deadline proximity").detail === "Overdue by 3 days", "Deadline detail reads naturally");

  // awaiting me
  const pts = [0, 1, 2, 3, 4, 5, 9].map((a) => awaitingMePoints(a));
  ok(group, JSON.stringify(pts) === JSON.stringify([7, 9, 11, 13, 15, 15, 15]), `Awaiting-you points by business-day age (SLA 2): ${pts.join(",")}`);
  const wait = (since: string, count = 1): ScoringOptions => ({ model: "v2", awaitingMeByKey: { "X-1": { sinceIso: since, count } } });
  ok(group, f(s2({}, wait("2026-10-27")), "Awaiting you").contribution === 7 && f(s2({}, wait("2026-10-23")), "Awaiting you").contribution === 11 && f(s2({}, wait("2026-10-20")), "Awaiting you").contribution === 15 && f(s2({}), "Awaiting you").contribution === 0, "the factor uses the signal for this ticket only (none -> 0)");
  ok(group, awaitingMeAgeBusinessDays({ sinceIso: "2026-10-23T10:00:00.000Z", count: 1 }, today) === 2 && f(s2({}, wait("2026-10-23", 3)), "Awaiting you").detail.includes("3 mentions"), "age counts business days (Fri -> Tue = 2); several mentions are named");
  const replies: Record<string, MentionReply> = { c2: { commentId: "c2", issueKey: "X-1", repliedAt: "2026-10-26", source: "manual" } };
  const sig = buildAwaitingMe([{ issueKey: "X-1", commentId: "c1", mentionedAt: "2026-10-22" }, { issueKey: "X-1", commentId: "c2", mentionedAt: "2026-10-21" }, { issueKey: "X-2", commentId: "c3", mentionedAt: "2026-10-26" }], replies);
  ok(group, sig["X-1"].sinceIso === "2026-10-22" && sig["X-1"].count === 1 && sig["X-2"].count === 1 && !buildAwaitingMe(undefined, undefined)["X-1"], "an answered mention does not count; the oldest unanswered one sets the age; missing inputs are fine");

  ok(group, f(s2({ blocked: true }), "Blocker status").contribution === 15 && f(s2(), "Blocker status").contribution === 0, "Blocker 15");
  const dep = (id: string): Dependency => ({ id, workItemId: "jira-X-1", description: "d", dependsOnTeam: "T", status: "unresolved", raisedDate: today });
  ok(group, f(s2({ dependencyIds: ["d1"] }, v2, [dep("d1")]), "Dependency risk").contribution === 3 && f(s2({ dependencyIds: ["d1", "d2", "d3"] }, v2, [dep("d1"), dep("d2"), dep("d3")]), "Dependency risk").contribution === 5, "Dependency: 1 -> 3, 2 or more -> 5 (max 5)");
  ok(group, f(s2({ lastUpdated: "2026-10-20" }), "Aging").contribution === 7 && f(s2({ lastUpdated: "2026-09-01" }), "Aging").contribution === 10, "Aging falls back to lastUpdated, capped at 10");
  ok(group, f(s2({ lastUpdated: today, statusCategoryChangedAt: "2026-10-22T08:00:00.000Z" }), "Aging").contribution === 5 && f(s2({ lastUpdated: today, statusCategoryChangedAt: "2026-10-22T08:00:00.000Z" }), "Aging").detail.startsWith("In this status category"), "Aging prefers statusCategoryChangedAt when present");
  ok(group, f(s2({ scopeChangeCount: 3 }), "Change frequency").contribution === 6 && f(s2({ scopeChangeCount: 99 }), "Change frequency").contribution === 10, "Change frequency 2 per change, max 10");
  ok(group, f(s2({ owner: undefined }), "Ownership risk").contribution === 5 && f(s2(), "Ownership risk").contribution === 0, "Ownership 5");
}

{
  const group = "P3.1 v2 totals, confidence, reasoning";
  const maxItem = mk({ priority: "P1", priorityKnown: true, dueDate: "2026-10-01", blocked: true, dependencyIds: ["d1", "d2"], lastUpdated: "2026-09-01", scopeChangeCount: 5, owner: undefined });
  const deps: Dependency[] = ["d1", "d2"].map((id) => ({ id, workItemId: "jira-X-1", description: "d", dependsOnTeam: "T", status: "unresolved" as const, raisedDate: today }));
  const max = scoreWorkItem(maxItem, dataOf([], deps), today, { model: "v2", awaitingMeByKey: { "X-1": { sinceIso: "2026-10-01", count: 1 } } });
  ok(group, max.score === 100 && max.factors.reduce((s, x) => s + x.max, 0) === 100, `max possible score is exactly 100 and the factor maxima sum to 100 (${max.score})`);
  const withBi = scoreWorkItem({ ...maxItem, businessImpact: 5 }, dataOf([], deps), today, { model: "v2", awaitingMeByKey: { "X-1": { sinceIso: "2026-10-01", count: 1 } } });
  ok(group, withBi.score === 100 && withBi.factors.reduce((s, x) => s + x.max, 0) === 100 && withBi.factors.find((x) => x.name === "Priority")!.max === 10 && withBi.factors.find((x) => x.name === "Business impact")!.max === 10, "with a business-impact rating the weight is shared (Priority 10 + Business impact 10) and the total is still 100");
  const biPrio = (p: WorkItem["priority"]) => scoreWorkItem(mk({ priority: p, businessImpact: 3 }), dataOf(), today, v2).factors.find((x) => x.name === "Priority")!.contribution;
  ok(group, biPrio("P1") === 10 && biPrio("P2") === 7 && biPrio("P3") === 4 && biPrio("P4") === 0 && scoreWorkItem(mk({ businessImpact: 3 }), dataOf(), today, v2).factors.find((x) => x.name === "Business impact")!.contribution === 6, "scaled Priority 10/7/4/0 and Business impact rating x 2");
  const quiet = scoreWorkItem(mk({ priority: "P4", priorityKnown: true }), dataOf(), today, v2);
  ok(group, quiet.classification === "LOW" && quiet.reasoning.includes("no significant risk factors"), "a quiet ticket is LOW with the 'no significant factors' text");

  const conf = (over: Partial<WorkItem>) => s2(over).confidence;
  ok(group, conf({ dueDate: "2026-11-01" }) === 0.95 && conf({}) === 0.8 && conf({ dueDate: "2026-11-01", owner: undefined }) === 0.85 && conf({ owner: undefined }) === 0.7 && conf({ dueDate: "2026-11-01", priorityKnown: false }) === 0.9 && conf({ priorityKnown: false, owner: undefined }) === 0.65, "confidence: -0.15 no due date, -0.10 no owner, -0.05 unknown priority; no business-impact penalty in v2");
  ok(group, s2({ type: "release" as WorkItem["type"], dueDate: "2026-11-01" }).confidence === 0.85, "release without UAT % keeps its -0.10");

  const r = s2({ priority: "P1", jiraPriorityName: "Highest", priorityKnown: true, dueDate: "2026-10-24" });
  ok(group, r.reasoning === `Scored ${r.score}/100: Priority P1 (Highest in Jira) and overdue by 3 days.`, `reasoning names the top two factors: "${r.reasoning}"`);
  const one = s2({ priority: "P1", priorityKnown: true });
  ok(group, /^Scored \d+\/100: Priority P1\.$/.test(one.reasoning), "a single contributing factor is named alone");

  // eligibility rescale (v2): only the factors that can speak
  const rUnknown = s2({ priority: "P3", priorityKnown: false, dueDate: undefined, blocked: true, scopeChangeCount: 5, lastUpdated: "2026-10-01", owner: undefined });
  ok(group, eligibilityScoreV2(mk({ priorityKnown: false, dueDate: undefined }), rUnknown) === Math.round((rUnknown.score * 100) / 60), "eligibility: no priority and no due date -> rescaled against 60");
  const rKnown = s2({ priorityKnown: true, dueDate: "2026-11-01" });
  ok(group, eligibilityScore(mk({ priorityKnown: true, dueDate: "2026-11-01" }), rKnown, "v2") === rKnown.score && eligibilityScore(mk({ priorityKnown: true }), rKnown, "v2") === Math.round((rKnown.score * 100) / 80), "eligibility: nothing missing -> raw score; no due date -> against 80");
  ok(group, eligibilityScoreV2(mk({ priorityKnown: false, businessImpact: 3, dueDate: "2026-11-01" }), rKnown) === Math.round((rKnown.score * 100) / 90) && SCORE_V2_MAX.priorityWithBusinessImpact === 10, "eligibility: an unknown priority only costs 10 when a business-impact rating shares the weight");
}

{
  const group = "P3.1 Jira normalisation";
  const norm = (name?: string) => normalizeIssues([makeJiraIssue({ key: "J-1", ...(name ? { priority: { name } } : { priority: undefined }) } as never)], { baseUrl: "https://x.atlassian.net", today }).workItems[0];
  ok(group, norm("Highest").priorityKnown === true && norm("Highest").jiraPriorityName === "Highest" && norm("Highest").priority === "P1", "a recognised priority is known and keeps Jira's name");
  ok(group, norm("Urgent!?").priorityKnown === false && norm("Urgent!?").priority === "P3", "an unrecognised priority name is NOT trusted (placeholder P3)");
  const none = norm(undefined);
  ok(group, none.priorityKnown === false && none.jiraPriorityName === undefined, "no priority from Jira -> unknown");
}

{
  const group = "P3.1 Switching the model";
  // Jira-like data where v1 cannot see priority, v2 can.
  const items = [
    mk({ id: "jira-A-1", key: "A-1", priority: "P4", priorityKnown: true, dueDate: "2026-10-28", lastUpdated: "2026-10-20" }),
    mk({ id: "jira-A-2", key: "A-2", priority: "P1", priorityKnown: true, dueDate: "2026-10-29", lastUpdated: "2026-10-26" }),
    mk({ id: "jira-A-3", key: "A-3", priority: "P2", priorityKnown: true, lastUpdated: "2026-10-27", blocked: true }),
    mk({ id: "jira-A-4", key: "A-4", priority: "P1", priorityKnown: true, lastUpdated: "2026-10-27" }),
  ];
  const data = dataOf(items);
  const order = (o?: ScoringOptions) => deriveData(data, null, today, undefined, undefined, o).scores.map((s) => s.itemId).join(",");
  const v1First = order();
  const v2Order = order(v2);
  const v1Again = order({ model: "v1" });
  ok(group, v1First !== v2Order, `v2 changes the order (v1: ${v1First} / v2: ${v2Order})`);
  ok(group, v1First === v1Again, "switching back to v1 restores the old order exactly");
  // Action Plan: a P1 ticket with no other signal than being overdue is invisible to v1 (priority unused) but eligible in v2.
  const planData = dataOf([
    mk({ id: "jira-B-1", key: "B-1", priority: "P4", priorityKnown: true, dueDate: "2026-10-24", blocked: true, lastUpdated: "2026-10-10" }),
    mk({ id: "jira-B-2", key: "B-2", priority: "P1", priorityKnown: true, dueDate: "2026-10-24", lastUpdated: "2026-10-10" }),
  ]);
  const plan = (o?: ScoringOptions) => buildPlan(planData, today, 480, undefined, undefined, undefined, o).map((c) => c.id).join(",");
  ok(group, plan() === "plan-jira-B-1" && plan(v2).includes("plan-jira-B-2") && plan() === plan({ model: "v1" }), `the Action Plan follows the model too (v1: ${plan()} / v2: ${plan(v2)}), and v1 reproduces its old plan`);
  ok(group, order({ model: "v2", awaitingMeByKey: { "A-1": { sinceIso: "2026-10-01", count: 1 } } }).startsWith("jira-A-1") || order({ model: "v2", awaitingMeByKey: { "A-1": { sinceIso: "2026-10-01", count: 1 } } }) !== v2Order, "an unanswered mention moves a ticket up");
}

{
  const group = "P3.1 Snapshots and trends never cross models";
  const data = dataOf([mk({ priority: "P1", priorityKnown: true, dueDate: "2026-10-20" })]);
  const m1 = buildSnapshotMetrics(data, today, 0);
  const m2 = buildSnapshotMetrics(data, today, 0, undefined, undefined, undefined, v2);
  ok(group, m1.scoringModel === undefined && m2.scoringModel === "v2", "a v2 snapshot records its model; v1 snapshots (and every old one) carry no field");
  const trend = compareSnapshots(m2, { ...m1, deliveryConfidence: 10, attentionCount: 9, blockedCount: 5 }, "2026-10-26");
  ok(group, trend.modelChanged?.from === "v1" && trend.modelChanged.to === "v2" && trend.modelChanged.note.includes("2026-10-26"), "compareSnapshots reports 'model changed' with the date");
  ok(group, !trend.deltas.some((d) => ["Delivery confidence", "Needs attention", "Critical items"].includes(d.label)) && trend.deltas.some((d) => d.label === "Blocked items"), "score-based deltas are left out, count-based ones are still compared");
  const same = compareSnapshots(m2, { ...m2, deliveryConfidence: 10 });
  ok(group, same.modelChanged === undefined && same.deltas.some((d) => d.label === "Delivery confidence"), "same model: compared normally");
  const hist = [{ date: "2026-10-26", workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: { ...m1, deliveryConfidence: 70 } as SnapshotMetrics }];
  const drift = computeDeliveryDrift(hist, m2 as SnapshotMetrics);
  ok(group, drift.level === "STABLE" && drift.snapshotsUsed === 0 && drift.evidence[0].includes("Scoring model changed since 2026-10-26"), "delivery drift restarts instead of comparing v1 with v2");
  ok(group, computeTrajectory(hist, m2 as SnapshotMetrics).level === "INSUFFICIENT_HISTORY", "the trajectory ignores snapshots scored by another model");
  ok(group, computeDeliveryDrift(hist, m1 as SnapshotMetrics).snapshotsUsed === 1, "…but still uses same-model history");
}

{
  const group = "P3.1 Stored state";
  const old = JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira" });
  ok(group, parseStoredState(old).scoringModel === "v2", "an old stored blob without scoringModel loads as v2 (the default)");
  ok(group, parseStoredState(JSON.stringify({ ...JSON.parse(old), scoringModel: "v1" })).scoringModel === "v1" && parseStoredState(JSON.stringify({ ...JSON.parse(old), scoringModel: "v3" })).scoringModel === "v2", "v1 persists; an unknown value falls back to v2");
}

{
  const group = "P3.1 Performance";
  const { data } = buildPerfData(today);
  const t0 = performance.now();
  const scores = scoreAllWorkItems(data, today, undefined, undefined, { model: "v2", awaitingMeByKey: {} });
  const ms = performance.now() - t0;
  ok(group, scores.length > 1000 && ms <= perfBudget(200), `v2 scores the ${scores.length} open items of the 3,000-item fixture in ${ms.toFixed(1)} ms (budget ${perfBudget(200)} ms)`);
}
