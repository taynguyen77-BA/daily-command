// DEMO DATA — fictional clients/projects only. Clearly labeled as demo data in the UI
// (see DataImport / EmptyState). Never presented as a real integration (BUILD REQUEST §16, §23).

import { addDays } from "./date-utils";
import { buildSnapshotMetrics } from "./memory";
import type { CommandCenterData, DailySnapshot } from "./types";

function offset(todayIso: string, days: number): string {
  return addDays(todayIso, days);
}

export function buildDemoData(todayIso: string): { snapshotHistory: DailySnapshot[]; current: CommandCenterData } {
  const iso = (n: number) => offset(todayIso, n);

  const clients = [
    { id: "c-jpmc", name: "JPMC" },
    { id: "c-ubs", name: "UBS" },
    { id: "c-wf", name: "WF" },
    { id: "c-barclays", name: "Barclays" },
    { id: "c-diners", name: "Diners" },
  ];

  const projectsCurrent = [
    { id: "p-jpmc", name: "JPMC Digital Onboarding Release", clientId: "c-jpmc", releaseDate: iso(2), status: "at-risk" as const },
    { id: "p-ubs", name: "UBS Trade Reporting Upgrade", clientId: "c-ubs", releaseDate: iso(20), status: "on-track" as const },
    { id: "p-wf", name: "WF Payments Rollout", clientId: "c-wf", releaseDate: iso(10), status: "at-risk" as const },
    { id: "p-barclays", name: "Barclays KYC Automation", clientId: "c-barclays", releaseDate: iso(30), status: "on-track" as const },
    { id: "p-diners", name: "Diners Card Migration", clientId: "c-diners", status: "on-track" as const },
  ];

  const workItemsCurrent = [
    { id: "wi-jpmc-101", key: "JPMC-101", title: "Release readiness sign-off", projectId: "p-jpmc", clientId: "c-jpmc", type: "release" as const, status: "Blocked" as const, priority: "P1" as const, owner: "Minh Tran", dueDate: iso(1), createdDate: iso(-14), lastUpdated: iso(-1), blocked: true, blockerReason: "Pending final UAT evidence from QA", dependencyIds: ["dep-jpmc-2"], riskIds: [], businessImpact: 5 as const, uatCompletionPct: 62, scopeChangeCount: 1, fixVersion: "2026.09" },
    { id: "wi-jpmc-102", key: "JPMC-102", title: "UAT defect triage", projectId: "p-jpmc", clientId: "c-jpmc", type: "bug" as const, status: "In Progress" as const, priority: "P2" as const, owner: "Minh Tran", dueDate: iso(3), createdDate: iso(-10), lastUpdated: iso(0), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 4 as const, scopeChangeCount: 0, fixVersion: "2026.09" },
    { id: "wi-jpmc-103", key: "JPMC-103", title: "Prod smoke test automation", projectId: "p-jpmc", clientId: "c-jpmc", type: "task" as const, status: "Not Started" as const, priority: "P3" as const, dueDate: iso(12), createdDate: iso(-3), lastUpdated: iso(-3), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 2 as const, scopeChangeCount: 0, fixVersion: "2026.09" },
    { id: "wi-jpmc-104", key: "JPMC-104", title: "Payment gateway integration", projectId: "p-jpmc", clientId: "c-jpmc", type: "story" as const, status: "Blocked" as const, priority: "P1" as const, owner: "Linh Pham", dueDate: iso(1), createdDate: iso(-20), lastUpdated: iso(0), blocked: true, blockerReason: "Waiting on sandbox credentials from Engineering", dependencyIds: ["dep-jpmc-1"], riskIds: [], businessImpact: 5 as const, scopeChangeCount: 2, fixVersion: "2026.09" },
    { id: "wi-jpmc-105", key: "JPMC-105", title: "Checkout 500 errors in prod", projectId: "p-jpmc", clientId: "c-jpmc", type: "production-issue" as const, status: "Blocked" as const, priority: "P1" as const, dueDate: iso(1), createdDate: iso(-1), lastUpdated: iso(0), blocked: true, blockerReason: "Waiting on Infrastructure to approve a rollback of the last deploy", dependencyIds: ["dep-jpmc-3"], riskIds: [], businessImpact: 5 as const, scopeChangeCount: 0, fixVersion: "2026.09" },

    { id: "wi-ubs-201", key: "UBS-201", title: "Trade report schema migration", projectId: "p-ubs", clientId: "c-ubs", type: "task" as const, status: "In Progress" as const, priority: "P2" as const, owner: "Sara Ali", dueDate: iso(25), createdDate: iso(-15), lastUpdated: iso(-1), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 3 as const, scopeChangeCount: 0 },
    { id: "wi-ubs-202", key: "UBS-202", title: "Reg reporting validation rules", projectId: "p-ubs", clientId: "c-ubs", type: "story" as const, status: "In Review" as const, priority: "P2" as const, owner: "Sara Ali", dueDate: iso(18), createdDate: iso(-25), lastUpdated: iso(-2), blocked: false, dependencyIds: [], riskIds: ["risk-ubs-ambiguity"], businessImpact: 4 as const, scopeChangeCount: 0 },
    { id: "wi-ubs-203", key: "UBS-203", title: "Data feed integration", projectId: "p-ubs", clientId: "c-ubs", type: "task" as const, status: "Blocked" as const, priority: "P2" as const, owner: "Sara Ali", dueDate: iso(15), createdDate: iso(-12), lastUpdated: iso(-1), blocked: true, blockerReason: "Waiting on Data Platform feed spec", dependencyIds: ["dep-ubs-1"], riskIds: [], businessImpact: 3 as const, scopeChangeCount: 1 },

    { id: "wi-wf-301", key: "WF-301", title: "Payments rollout — Phase 1", projectId: "p-wf", clientId: "c-wf", type: "release" as const, status: "In Progress" as const, priority: "P1" as const, owner: "Carlos Diaz", dueDate: iso(9), createdDate: iso(-30), lastUpdated: iso(0), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 5 as const, uatCompletionPct: 40, scopeChangeCount: 4 },
    { id: "wi-wf-302", key: "WF-302", title: "Fraud rule engine integration", projectId: "p-wf", clientId: "c-wf", type: "story" as const, status: "Not Started" as const, priority: "P1" as const, owner: "Carlos Diaz", dueDate: iso(8), createdDate: iso(-5), lastUpdated: iso(-1), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 4 as const, scopeChangeCount: 0 },
    { id: "wi-wf-303", key: "WF-303", title: "Reconciliation report bug", projectId: "p-wf", clientId: "c-wf", type: "bug" as const, status: "In Progress" as const, priority: "P2" as const, owner: "Priya Nair", dueDate: iso(6), createdDate: iso(-9), lastUpdated: iso(-8), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 3 as const, scopeChangeCount: 0 },

    { id: "wi-barclays-401", key: "BARC-401", title: "KYC document OCR pipeline", projectId: "p-barclays", clientId: "c-barclays", type: "story" as const, status: "In Progress" as const, priority: "P2" as const, owner: "Tom Reid", dueDate: iso(20), createdDate: iso(-18), lastUpdated: iso(-1), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 3 as const, scopeChangeCount: 0 },
    { id: "wi-barclays-402", key: "BARC-402", title: "Sanctions screening rules", projectId: "p-barclays", clientId: "c-barclays", type: "story" as const, status: "Done" as const, priority: "P2" as const, owner: "Tom Reid", dueDate: iso(-2), createdDate: iso(-25), lastUpdated: iso(-3), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 4 as const, scopeChangeCount: 0 },

    { id: "wi-diners-501", key: "DIN-501", title: "Card migration discovery", projectId: "p-diners", clientId: "c-diners", type: "task" as const, status: "Not Started" as const, priority: "P3" as const, dueDate: iso(25), createdDate: iso(-2), lastUpdated: iso(-2), blocked: false, dependencyIds: [], riskIds: [], businessImpact: 2 as const, scopeChangeCount: 0 },
  ];

  const dependenciesCurrent = [
    { id: "dep-jpmc-1", workItemId: "wi-jpmc-104", description: "Sandbox credentials for payment gateway", dependsOnTeam: "Engineering", status: "unresolved" as const, raisedDate: iso(-4) },
    { id: "dep-jpmc-2", workItemId: "wi-jpmc-101", description: "Final UAT evidence for remaining scope", dependsOnTeam: "QA", status: "unresolved" as const, raisedDate: iso(-3) },
    { id: "dep-jpmc-3", workItemId: "wi-jpmc-105", description: "Rollback approval for last production deploy", dependsOnTeam: "Infrastructure", status: "unresolved" as const, raisedDate: iso(-1) },
    { id: "dep-ubs-1", workItemId: "wi-ubs-203", description: "Data Platform feed spec", dependsOnTeam: "Data Platform", status: "unresolved" as const, raisedDate: iso(-6) },
  ];

  const requirementsCurrent = [
    { id: "req-jpmc-1", projectId: "p-jpmc", title: "Release sign-off checklist requirement", status: "approved" as const, businessImpact: 5 as const, testCoveragePct: 40 },
    { id: "req-wf-1", projectId: "p-wf", title: "Fraud rule accuracy requirement", status: "changed" as const, businessImpact: 4 as const },
    { id: "req-ubs-1", projectId: "p-ubs", title: "Reg reporting completeness", status: "approved" as const, businessImpact: 3 as const, testCoveragePct: 80 },
  ];

  const risksCurrent = [
    { id: "risk-ubs-ambiguity", projectId: "p-ubs", title: "UBS reporting rules ambiguity", level: "MEDIUM" as const, reason: "Validation rules were open to interpretation by QA.", evidence: ["Raised during UAT review", "Clarified with UBS business analyst"], potentialImpact: "Incorrect regulatory report formatting.", mitigation: "Rules clarified and documented; monitor next UAT cycle.", status: "closed" as const, confidence: 0.7, detectedAt: iso(0), sourceWorkItemIds: ["wi-ubs-202"], auto: false },
  ];

  const decisionsCurrent = [
    {
      id: "decision-jpmc-1", projectId: "p-jpmc", clientId: "c-jpmc",
      title: "JPMC release remains on current date",
      status: "ACTIVE" as const,
      description: "Need sign-off from the JPMC release board on remaining UAT gaps.",
      dueDate: iso(1), date: iso(-5),
      context: "Release board confirmed the target date could hold if UAT closed out on schedule.",
      decision: "Keep the JPMC release date as planned.",
      owner: "Minh Tran",
      impact: "Release board and client communications are aligned to this date.",
      relatedWorkItemIds: ["wi-jpmc-101", "wi-jpmc-104", "wi-jpmc-105"],
    },
    {
      id: "decision-wf-1", projectId: "p-wf", clientId: "c-wf",
      title: "WF fraud rules rollout deferred to Phase 2",
      status: "SUPERSEDED" as const,
      description: "Originally planned for Phase 1; deferred after a scope review.",
      date: iso(-10),
      context: "Initial WF rollout scope included fraud rules in Phase 1.",
      decision: "Move fraud rule engine integration to Phase 2.",
      owner: "Carlos Diaz",
      impact: "Phase 1 scope reduced; fraud rules ship later.",
      relatedWorkItemIds: ["wi-wf-302"],
    },
    {
      id: "decision-ubs-1", projectId: "p-ubs", clientId: "c-ubs",
      title: "UBS validation ambiguity resolved via documentation",
      status: "REVISIT_REQUIRED" as const,
      description: "Rules were clarified during UAT; revisit if new validation edge cases appear.",
      date: iso(-6),
      context: "QA flagged ambiguous validation rules during UAT review.",
      decision: "Document the interpretation and proceed without a rule change.",
      owner: "Sara Ali",
      impact: "Unblocks UAT continuation; risk of recurrence if new edge cases appear.",
      relatedWorkItemIds: ["wi-ubs-202"],
    },
  ];

  const actionsCurrent = [
    { id: "action-seed-1", title: "Assign validation owner for JPMC release", why: "UAT evidence is incomplete and the release date is approaching.", relatedWorkItemId: "wi-jpmc-101", status: "open" as const, estimateMinutes: 15, dueDate: iso(0), createdAt: iso(-1) },
    { id: "action-seed-2", title: "Follow up with Data Platform on UBS feed spec", why: "Dependency has been unresolved for 6 days.", relatedWorkItemId: "wi-ubs-203", status: "open" as const, estimateMinutes: 10, dueDate: iso(0), createdAt: iso(-1) },
    { id: "action-seed-3", title: "Escalate WF payments rollout scope risk", why: "Repeated scope changes are threatening the Phase 1 timeline.", relatedWorkItemId: "wi-wf-301", owner: "Carlos Diaz", status: "completed" as const, estimateMinutes: 15, createdAt: iso(-2), completedAt: iso(-1), outcome: "Escalated to the program lead; no confirmed mitigation yet." },
  ];

  const communicationsCurrent = [
    { id: "comm-seed-1", workItemId: "wi-jpmc-101", audience: "Client" as const, who: "JPMC Release Board", why: "UAT evidence is incomplete and the release date is approaching.", whatTheyNeedToKnow: "Remaining UAT scope and whether any blocking issues are still open.", suggestedMessage: "Hi team, could you please confirm the remaining UAT scope for the JPMC release and whether any blocking issues are still open?", status: "open" as const },
    { id: "comm-seed-2", workItemId: "wi-jpmc-104", audience: "Engineering" as const, who: "Engineering — Sandbox team", why: "Blocking dependency has been unresolved for 4+ days.", whatTheyNeedToKnow: "An ETA for sandbox credentials, or a workaround.", suggestedMessage: `Hi Engineering team, JPMC-104 has been blocked on sandbox credentials since ${iso(-4)} — could you share an ETA or a workaround so we can keep the payment gateway integration on track?`, status: "open" as const },
  ];

  const current: CommandCenterData = {
    clients,
    projects: projectsCurrent,
    workItems: workItemsCurrent,
    requirements: requirementsCurrent,
    risks: risksCurrent,
    dependencies: dependenciesCurrent,
    decisions: decisionsCurrent,
    actions: actionsCurrent,
    communications: communicationsCurrent,
  };

  // "Yesterday" — the day immediately before "current" — deliberately different on a
  // handful of fields so What Changed has real, meaningful diffs to show on first load.
  const yesterdayData: CommandCenterData = {
    ...current,
    projects: projectsCurrent,
    workItems: workItemsCurrent.map((w) => {
      if (w.id === "wi-jpmc-101") return { ...w, dueDate: iso(3), uatCompletionPct: 55, blocked: false, blockerReason: undefined, status: "In Progress" as const, dependencyIds: [] };
      if (w.id === "wi-jpmc-104") return { ...w, dueDate: iso(5), status: "In Progress" as const, blocked: false, blockerReason: undefined };
      if (w.id === "wi-ubs-203") return { ...w, owner: undefined };
      if (w.id === "wi-wf-302") return { ...w, priority: "P3" as const };
      return w;
    }),
    risks: risksCurrent.map((r) => (r.id === "risk-ubs-ambiguity" ? { ...r, status: "open" as const } : r)),
    requirements: requirementsCurrent.map((r) => (r.id === "req-wf-1" ? { ...r, status: "draft" as const } : r)),
    dependencies: dependenciesCurrent,
  };
  const yesterday: DailySnapshot = {
    date: iso(-1),
    projects: yesterdayData.projects,
    workItems: yesterdayData.workItems,
    risks: yesterdayData.risks,
    requirements: yesterdayData.requirements,
    dependencies: yesterdayData.dependencies,
    metrics: buildSnapshotMetrics(yesterdayData, iso(-1), 4),
  };

  // Two earlier days, hand-authored at the metrics level only (V1.2 §2: "avoid storing
  // unnecessary duplicate raw data" — older history only needs to answer trend/pattern
  // questions, never re-diffed against, so no raw work-item arrays are retained for them).
  // Deliberately keeps the JPMC-Engineering dependency and its blocked-item risk present on
  // both days so Recurring Pattern Detection has real, dated evidence out of the box.
  const dayBefore: DailySnapshot = {
    date: iso(-2),
    projects: [], workItems: [], risks: [], requirements: [], dependencies: [],
    metrics: {
      attentionCount: 2, criticalCount: 0, highRiskCount: 2, blockedCount: 1, overdueCount: 1,
      deliveryConfidence: 58, openDecisionsCount: 3, unresolvedDependenciesCount: 2,
      majorRiskTitles: ["JPMC — JPMC-104 blocked by unresolved dependency", "JPMC — JPMC-104 has no owner"],
      unresolvedDependencyTeams: ["Engineering", "Data Platform"],
      meaningfulChangeCount: 3,
    },
  };
  const twoDaysBefore: DailySnapshot = {
    date: iso(-3),
    projects: [], workItems: [], risks: [], requirements: [], dependencies: [],
    metrics: {
      attentionCount: 2, criticalCount: 0, highRiskCount: 2, blockedCount: 1, overdueCount: 1,
      deliveryConfidence: 62, openDecisionsCount: 3, unresolvedDependenciesCount: 2,
      majorRiskTitles: ["JPMC — JPMC-104 blocked by unresolved dependency"],
      unresolvedDependencyTeams: ["Engineering", "Data Platform"],
      meaningfulChangeCount: 2,
    },
  };

  return { snapshotHistory: [twoDaysBefore, dayBefore, yesterday], current };
}
