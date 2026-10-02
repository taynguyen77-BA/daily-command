// V2.2.x — evidence → delivery artifacts, deployment-readiness fixes
// Run through scripts/tests/run.mts (npm test).

import { toSnapshot } from "../../src/lib/command-center/change-detection";
import { emptyData } from "../../src/lib/command-center/types";
import { aiRequestSchema } from "../../src/lib/command-center/ai/schemas";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { ClaudeProvider } from "../../src/lib/command-center/ai/claude-provider";
import { parseStoredState, commandCenterStore } from "../../src/lib/command-center/store";
import { fetchJiraIssuesWith, fetchJiraProjectsWith, buildIssuesJql, classifyHttpError, JIRA_PAGE_SIZE, type FetchLike } from "../../src/lib/command-center/jira/http";
import { computeReleaseHealth } from "../../src/lib/command-center/release-health";
import { classifyQuery, familyForIntent } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import { evaluateAiResponse } from "../../src/lib/command-center/ai/evaluation";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { buildDecisionBriefDraft, buildMeetingModeBrief, buildNeedsFromOthers, buildReleaseUpdateDraft, buildStakeholderUpdateDraft, buildStatusUpdateDraft, buildTodaysUpdateDraft, isArtifactStale, rebuildDraftFromSourceRef, renderArtifactText, renderMeetingModeText, renderNeedsFromOthersText, summarizeArtifactTrust } from "../../src/lib/command-center/communicate";
import { artifactUsageKey, commandUsageKey, computeUsageSummary } from "../../src/lib/command-center/usage";
import { isArtifactIntent } from "../../src/lib/command-center/query-router";
import { communicationArtifactResponseSchema } from "../../src/lib/command-center/ai/schemas";
import type { WhyShouldICareContent } from "../../src/lib/command-center/why-should-i-care";
import type { DecisionOptionsResult } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { TODAY, makeJiraIssue, v22Blocked, v22Data, v22Dep, v22Derived, v22Normal, v22PersonalFocus, v22Proactive } from "./helpers.mts";

// ----- Artifact composition -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.type === "STATUS_UPDATE", "buildStatusUpdateDraft produces a STATUS_UPDATE artifact");
  ok(
    "V2.2 Artifact composition",
    statusDraft.sections.map((s) => s.heading).join(",") === "Overall,What changed,Top risks,Decisions needed,Actions,Next",
    "the Daily Status Update has exactly the §4.1 section headings, in order"
  );
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion.length > 0, "a fresh draft always carries a non-empty evidenceVersion");
  ok("V2.2 Artifact composition", statusDraft.sourceRef?.type === "status", "buildStatusUpdateDraft tags a rebuildable sourceRef for staleness checking");

  const statusDraftAgain = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion === statusDraftAgain.evidenceVersion, "identical inputs produce an identical evidenceVersion — deterministic, not random");

  // A real "what changed" event (not just an unrelated new item) must move evidenceVersion:
  // simulate a previous snapshot where v22Blocked wasn't yet blocked.
  const previousDataForChange: CommandCenterData = { ...v22Data, workItems: [{ ...v22Blocked, status: "In Progress", blocked: false, blockerReason: undefined }, v22Normal] };
  const previousSnapshotForChange = toSnapshot(previousDataForChange, "2026-06-14");
  const derived2 = deriveData(v22Data, previousSnapshotForChange, TODAY);
  const proactive2 = computeProactiveIntelligence(v22Data, derived2, [previousSnapshotForChange], previousSnapshotForChange, {}, "manual", TODAY);
  const personalFocus2 = computePersonalFocus(v22Data, proactive2, undefined, TODAY);
  const statusDraft2 = buildStatusUpdateDraft(v22Data, derived2, proactive2, personalFocus2, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion !== statusDraft2.evidenceVersion, "a real change in the underlying data (a detected status change) changes evidenceVersion — the staleness basis actually tracks facts");

  const todaysUpdate = buildTodaysUpdateDraft(v22Data, v22Proactive, v22PersonalFocus, TODAY);
  ok(
    "V2.2 Artifact composition",
    todaysUpdate.sections.map((s) => s.heading).join(",") === "Today,Watch,Don't forget,Decisions,Actions,Delivery",
    "§11 'Create Today's Update' uses the TODAY/WATCH/DON'T FORGET/DECISIONS/ACTIONS/DELIVERY layout"
  );
  ok("V2.2 Artifact composition", todaysUpdate.sourceRef?.type === "todays-update", "Today's Update carries its own distinct sourceRef kind");

  const emptyDraft = buildStatusUpdateDraft(emptyData(), deriveData(emptyData(), null, TODAY), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY), null, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", emptyDraft.sections.every((s) => s.segments.length > 0), "an empty dataset never produces an empty section — every section falls back to an honest 'nothing' statement, never a crash");
}


// ----- Stakeholder Update: fact preservation (§9) -----
{
  const attItem: AttentionItem = {
    id: "v22-att-1",
    category: "RISK",
    severity: "HIGH",
    what: "Ledger sync at risk",
    why: "Blocked on API contract from Platform",
    impact: "Release R-2026.1 may slip",
    nowWhat: "Escalate to Platform team lead",
    evidence: ["Blocked since 2026-06-10", "P1 priority"],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
  };
  const stakeholderDraft = buildStakeholderUpdateDraft({ kind: "attention", item: attItem }, "Attention Queue");
  ok(
    "V2.2 Stakeholder Update",
    stakeholderDraft.sections.map((s) => s.heading).join(",") === "Subject,Current situation,Impact,What we need,Next step",
    "the Stakeholder Update has exactly the §4.2 section headings"
  );
  ok("V2.2 Stakeholder Update", stakeholderDraft.sections.find((s) => s.heading === "Current situation")?.segments[0].text === attItem.why, "'Current situation' preserves the attention item's WHY verbatim, never rephrased");
  ok("V2.2 Stakeholder Update", stakeholderDraft.evidence.map((e) => e.content).join("|") === attItem.evidence.join("|"), "the artifact's evidence is exactly the source item's evidence — no invented facts");
  ok("V2.2 Stakeholder Update", stakeholderDraft.sourceRef?.type === "attention" && stakeholderDraft.sourceRef.itemId === attItem.id, "the attention-sourced draft tags a rebuildable sourceRef");

  const wsicContent: WhyShouldICareContent = {
    fact: ["Status: UNDER_REVIEW", "No decision date recorded"],
    signal: "Decision Radar flags this for review.",
    impact: { currentCondition: "Decision is under review.", unresolvedSignal: "If no intervention occurs, this decision is expected to remain unreviewed.", affectedEntities: [], evidence: [], confidence: 0.7, insufficientEvidence: false },
    unknown: ["No review date is set for this decision."],
    nextMove: "Review, keep, or mark this decision superseded.",
    evidence: [],
  };
  const wsicDraft = buildStakeholderUpdateDraft({ kind: "why-should-i-care", content: wsicContent, subjectTitle: "Choose vendor" }, "Decision: Choose vendor");
  const wsicUnknownSection = wsicDraft.sections.find((s) => s.heading === "Unknown");
  ok("V2.2 Stakeholder Update", !!wsicUnknownSection && wsicUnknownSection.segments[0].kind === "UNKNOWN" && wsicUnknownSection.segments[0].text === wsicContent.unknown[0], "Why Should I Care's UNKNOWN facts are preserved verbatim as UNKNOWN-kind segments, never silently dropped or reworded");
  const currentSituationText = wsicDraft.sections.find((s) => s.heading === "Current situation")!.segments.map((s) => s.text);
  ok("V2.2 Stakeholder Update", wsicContent.fact.every((f) => currentSituationText.includes(f)), "every FACT string from Why Should I Care appears verbatim in the artifact — the AI may draft wording separately, but it never replaces these facts");
  ok("V2.2 Stakeholder Update", wsicDraft.sourceRef === undefined, "a Why-Should-I-Care-sourced draft has no cheap rebuild path — staleness must be reported 'unavailable', never faked");
}


// ----- Release Update -----
{
  const release = computeReleaseHealth(v22Data, "R-2026.1", TODAY);
  const releaseDraft = buildReleaseUpdateDraft(release, v22Data, "Release Health");
  ok(
    "V2.2 Release Update",
    releaseDraft.sections.map((s) => s.heading).join(",") === "Release,Confidence,Completion,Readiness,Key blockers,Open dependencies,Decisions,Next actions",
    "the Release Update has exactly the §4.3 section headings (+ B5's Completion, the one release number)"
  );
  ok("V2.2 Release Update", releaseDraft.sections.find((s) => s.heading === "Release")?.segments[0].text === "R-2026.1", "the Release section names the exact fix version");
  const openDepsText = releaseDraft.sections.find((s) => s.heading === "Open dependencies")!.segments.map((s) => s.text).join(" ");
  ok("V2.2 Release Update", openDepsText.includes(v22Dep.description), "an unresolved dependency on a work item in this release appears in Open Dependencies");
  ok("V2.2 Release Update", releaseDraft.sourceRef?.type === "release" && releaseDraft.sourceRef.fixVersion === "R-2026.1", "the release draft tags a rebuildable sourceRef");
  ok(
    "V2.18 Trust wording",
    releaseDraft.sections.find((s) => s.heading === "Confidence")!.segments[0].text === `${release.deliveryConfidence}/100`,
    "the auto-generated Release Update's Confidence section reads 'N/100', never 'N%' — deliveryConfidence is a deterministic heuristic score, not a statistical probability"
  );
}


// ===== V2.18 §11 — Trust/confidence wording audit: heuristic score never dressed up as a
// probability, and "no outcomes measured yet" never conflated with "all outcomes were good" =====
{
  ok(
    "V2.18 Trust wording",
    !/\{deliveryConfidence\}%/.test(fs.readFileSync(path.join(process.cwd(), "src/components/command-center/ControlTower.tsx"), "utf8")),
    "ControlTower no longer renders the deterministic 0-100 heuristic score with a literal '%' — it uses the same honest '/100' framing ExecutiveView.tsx already used"
  );

  const controlTowerSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/ControlTower.tsx"), "utf8");
  ok("V2.18 Trust wording", /proactive\.actionEffectiveness\.length === 0/.test(controlTowerSrc), "ControlTower's Action tile checks actionEffectiveness.length === 0 before ever rendering 'All effective' — zero-outcomes-measured is now distinguishable from zero-ineffective-among-many");
  ok("V2.18 Trust wording", /No action outcomes yet/.test(controlTowerSrc), "the zero-measured case gets its own honest label, not silently reusing 'All effective'");
}


// ----- Decision Brief — the system never decides (§4) -----
{
  const decItem: AttentionItem = {
    id: "v22-att-dec",
    category: "DECISION",
    severity: "MEDIUM",
    what: "Choose vendor for reconciliation service",
    why: "Decision has been open for 12 days without review",
    impact: "Delays downstream integration work",
    nowWhat: "Review and confirm or supersede",
    evidence: ["Opened 2026-06-03", "No owner assigned"],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
  };
  const decisionOptions: DecisionOptionsResult = {
    summary: "Two viable vendors identified.",
    options: [
      { id: "A", label: "Vendor A", rationale: "Lower cost", upside: "Cheaper", downside: "Slower support", dependencies: [], risks: [], evidence: [], confidence: 0.6 },
      { id: "B", label: "Vendor B", rationale: "Faster integration", upside: "Faster", downside: "Higher cost", dependencies: [], risks: [], evidence: [], confidence: 0.55 },
    ],
    recommendedOptionId: "A",
    tradeoffs: "Vendor A trades support speed for cost; Vendor B trades cost for speed.",
    confidence: 0.6,
  };
  const briefDraft = buildDecisionBriefDraft(decItem, decisionOptions, "Decision Radar");
  ok(
    "V2.2 Decision Brief",
    briefDraft.sections.map((s) => s.heading).join(",") === "Decision,Why now,Options,Trade-offs,Evidence,Recommended human decision",
    "the Decision Brief has exactly the §4.4 section headings"
  );
  const briefSummary = summarizeArtifactTrust(briefDraft.sections);
  ok("V2.2 Decision Brief", briefSummary.userInputCount === 1, "'Recommended human decision' is the only USER_INPUT segment — left for the human, never pre-filled by AI");
  ok("V2.2 Decision Brief", briefSummary.aiDraftCount === decisionOptions.options.length + 1, "Options + Trade-offs are labeled AI_DRAFT (they came from generateDecisionOptions) — one segment per option plus the trade-offs line");
  ok(
    "V2.2 Decision Brief",
    briefDraft.sections.find((s) => s.heading === "Recommended human decision")!.segments[0].text.toLowerCase().includes("not yet decided"),
    "the human-decision section is explicitly a placeholder, never a fabricated recommendation presented as the decision"
  );
}


// ----- Needs From Others (§13) — never guess owner/deadline -----
{
  const rows = buildNeedsFromOthers(v22Data, v22Proactive);
  ok("V2.2 Needs From Others", rows.length > 0, "an unowned P1 work item and an unowned dependency produce at least one row");
  const unknownRow = rows.find((r) => r.isUnknownPerson);
  ok("V2.2 Needs From Others", !!unknownRow && unknownRow.person === "UNKNOWN" && unknownRow.by === "UNKNOWN", "when no owner is available, person/by literally read UNKNOWN rather than a guess");
  ok("V2.2 Needs From Others", renderNeedsFromOthersText(rows).includes("No owner/deadline is available in the source data."), "the rendered text explains the UNKNOWN, matching the spec's worked example");

  const noneRows = buildNeedsFromOthers(emptyData(), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY));
  ok("V2.2 Needs From Others", noneRows.length === 0, "an empty dataset produces zero rows, not a crash or a fabricated need");
  ok("V2.2 Needs From Others", renderNeedsFromOthersText(noneRows) === "NEEDS FROM OTHERS\n(none currently)", "zero rows render an honest 'none currently' rather than an empty string");
}


// ----- Meeting Mode -----
{
  const brief = buildMeetingModeBrief(v22Data, v22Derived, v22Proactive, TODAY);
  ok("V2.2 Meeting Mode", brief.questions.length === 5, "Meeting Mode surfaces exactly the 5 evidence-backed questions (the 6th, 'what should I say', is a separate deterministic summary field)");
  const blockedQ = brief.questions.find((q) => q.question === "What is blocked?");
  ok("V2.2 Meeting Mode", !!blockedQ && blockedQ.items.some((i) => i.includes("V22-1")), "the blocked work item appears under 'What is blocked?'");
  ok("V2.2 Meeting Mode", brief.whatShouldISay.length > 0, "'What should I say?' is a non-empty deterministic summary, not an AI call");

  // V2.9 §F-07 fix — an unowned item's "person" is the literal string "UNKNOWN" on the
  // underlying NeedsFromOthersRow (asserted above); the "What do I need from others?" list
  // must never interpolate that literally, which read like an unresolved template variable
  // ("UNKNOWN: Assign an owner"), as if UNKNOWN were a real person or team's name.
  const needsFromOthersQ = brief.questions.find((q) => q.question === "What do I need from others?");
  ok("V2.9 Meeting Mode copy", !!needsFromOthersQ && needsFromOthersQ.items.length > 0, "sanity check: v22Data's unowned item(s) produce at least one 'needs from others' row");
  ok(
    "V2.9 Meeting Mode copy",
    !!needsFromOthersQ && needsFromOthersQ.items.every((i) => !i.startsWith("UNKNOWN:")),
    "no 'needs from others' line starts with the literal word UNKNOWN standing in for a person's name"
  );
  ok("V2.2 Meeting Mode", renderMeetingModeText(brief).startsWith("MEETING MODE"), "the copyable meeting summary is well-formed plain text");

  const emptyBrief = buildMeetingModeBrief(emptyData(), deriveData(emptyData(), null, TODAY), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY), TODAY);
  ok("V2.2 Meeting Mode", emptyBrief.questions.every((q) => q.items.length > 0), "an empty dataset still renders an honest 'nothing' answer for every question, never a blank/crashed section");
}


// ----- Trust model / Copy Safety (§5, §15) -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  const summary = summarizeArtifactTrust(statusDraft.sections);
  const totalSegments = statusDraft.sections.reduce((n, s) => n + s.segments.length, 0);
  ok("V2.2 Trust model", summary.calculatedCount + summary.evidenceCount + summary.aiDraftCount + summary.userInputCount + summary.unknownCount === totalSegments, "summarizeArtifactTrust's counts add up to the total segment count — nothing double-counted or missed");
  ok("V2.2 Trust model", summary.aiDraftCount === 0, "a freshly-built draft (no AI wording generated yet) has zero AI_DRAFT segments");

  const text = renderArtifactText(statusDraft.sections, "Suggested wording.");
  ok("V2.2 Trust model", text.includes("SUGGESTED WORDING (AI DRAFT)"), "renderArtifactText clearly labels AI-drafted wording as a separate block, never merges it into the facts silently");
}


// ----- Staleness (§17) -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Staleness", !isArtifactStale(statusDraft.evidenceVersion, statusDraft.evidenceVersion), "identical evidenceVersion is never reported stale");
  ok("V2.2 Staleness", isArtifactStale(statusDraft.evidenceVersion, "some-other-version"), "a changed evidenceVersion is reported stale");

  const rebuilt = rebuildDraftFromSourceRef(statusDraft.sourceRef, "Control Tower", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY);
  ok("V2.2 Staleness", !!rebuilt && rebuilt.evidenceVersion === statusDraft.evidenceVersion, "rebuilding from the same sourceRef against unchanged data reproduces the identical evidenceVersion");

  ok("V2.2 Staleness", rebuildDraftFromSourceRef(undefined, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "no sourceRef (e.g. a Decision Brief or Why-Should-I-Care draft) is honestly reported as not rebuildable, never faked");
  ok("V2.2 Staleness", rebuildDraftFromSourceRef({ type: "attention", itemId: "does-not-exist" }, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "a sourceRef pointing at an attention item that's no longer present rebuilds to null rather than fabricating stale content");
  ok("V2.2 Staleness", rebuildDraftFromSourceRef({ type: "release", fixVersion: "DOES-NOT-EXIST" }, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "a sourceRef pointing at a release no longer present in the data rebuilds to null");
}


// ----- AI: COMMUNICATION_ARTIFACT (§8) -----
{
  ok("V2.2 AI schema", communicationArtifactResponseSchema.safeParse({ text: "Draft wording.", confidence: 0.6 }).success, "a valid COMMUNICATION_ARTIFACT payload is accepted");
  ok("V2.2 AI schema", !communicationArtifactResponseSchema.safeParse({ text: "Draft wording." }).success, "a payload missing confidence is rejected");
  ok("V2.2 AI schema", !communicationArtifactResponseSchema.safeParse({ confidence: 0.6 }).success, "a payload missing text is rejected");
  ok("V2.2 AI schema", aiRequestSchema.safeParse({ task: "generateCommunicationArtifact", prompt: "..." }).success, "'generateCommunicationArtifact' is a recognized AITask");

  const mock = new MockAIProvider();
  const mockResult = await mock.generateCommunicationArtifact("STATUS_UPDATE", ["Trajectory: ON TRACK."], ["evidence 1"]);
  ok("V2.2 AI mock", mockResult.text.length > 0 && mockResult.confidence > 0, "MockAIProvider.generateCommunicationArtifact returns usable text built from the given facts, offline");
  const mockEmpty = await mock.generateCommunicationArtifact("STATUS_UPDATE", [], []);
  ok("V2.2 AI mock", mockEmpty.insufficientEvidence === true, "with zero facts, the mock honestly reports insufficientEvidence rather than fabricating a draft");

  const claude2 = new ClaudeProvider();
  let artifactThrew = false;
  try {
    await claude2.generateCommunicationArtifact("STATUS_UPDATE", ["fact"], []);
  } catch {
    artifactThrew = true;
  }
  ok("V2.2 AI Claude fallback", !artifactThrew, "ClaudeProvider.generateCommunicationArtifact never throws even when the server is unreachable");
  ok("V2.2 AI Claude fallback", claude2.mode === "mock", "mode reports 'mock' after the failed call, same fallback discipline as every other provider method");

  // §21 — reuse the existing evaluator, not a new one.
  const evalResult = evaluateAiResponse({
    task: "generateCommunicationArtifact",
    response: mockResult,
    schemaValid: true,
    narrativeText: mockResult.text,
    inputFacts: ["Trajectory: ON TRACK."],
    inputEvidence: ["evidence 1"],
    confidence: mockResult.confidence,
  });
  ok("V2.2 AI evaluation", evalResult.findings.length > 0, "evaluateAiResponse (ai/evaluation.ts, no new evaluator) runs cleanly against a COMMUNICATION_ARTIFACT response");
}


// ----- Command Bar artifact intents (§10) -----
{
  ok("V2.2 Command Bar", classifyQuery("create status update", v22Data).intent === "create-status-update", "'create status update' routes to create-status-update");
  ok("V2.2 Command Bar", classifyQuery("draft stakeholder update for JPMC", v22Data).intent === "create-stakeholder-update", "'draft stakeholder update for JPMC' routes to create-stakeholder-update");
  ok("V2.2 Command Bar", classifyQuery("draft stakeholder update for JPMC", v22Data).target === "JPMC", "the client name is extracted as the target, reusing the existing findTarget helper");
  ok("V2.2 Command Bar", classifyQuery("prepare release update", v22Data).intent === "create-release-update", "'prepare release update' routes to create-release-update");
  ok("V2.2 Command Bar", classifyQuery("please give me a quick release update", v22Data).intent === "create-release-update", "a near-miss phrasing containing 'release update' still routes correctly");
  ok("V2.2 Command Bar", classifyQuery("prepare decision brief", v22Data).intent === "create-decision-brief", "'prepare decision brief' routes to create-decision-brief");
  ok("V2.2 Command Bar", classifyQuery("summarize today's delivery", v22Data).intent === "summarize-today", "\"summarize today's delivery\" routes to summarize-today");
  ok("V2.2 Command Bar", classifyQuery("give me the daily summary", v22Data).intent === "summarize-today", "'daily summary' phrasing also routes to summarize-today");
  ok("V2.2 Command Bar", classifyQuery("asdkjhasdkjh nonsense query", v22Data).intent === "unrecognized", "an unrelated/nonsense query is never misrouted to an artifact intent");

  for (const intent of ["create-status-update", "create-stakeholder-update", "create-release-update", "create-decision-brief", "summarize-today"] as const) {
    ok("V2.2 Command Bar", isArtifactIntent(intent), `isArtifactIntent('${intent}') is true`);
    ok("V2.2 Command Bar", familyForIntent(intent) === "ARTIFACT", `familyForIntent('${intent}') is the ARTIFACT family, distinct from every AI-narrated family`);
  }
  ok("V2.2 Command Bar", !isArtifactIntent("blocking"), "an existing narrated intent is never misclassified as an artifact intent");
}


// ----- Store: Artifact History (§16) and Usage Observability (§22-23) -----
{
  commandCenterStore.resetAll();
  const draftForHistory = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");

  const id1 = commandCenterStore.saveArtifact(draftForHistory, { editedText: "edited body" });
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 1, "saveArtifact appends one record");
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts[0].editedText === "edited body", "the saved record keeps the user's edited text");

  commandCenterStore.updateArtifact(id1, { editedText: "changed body" });
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts[0].editedText === "changed body", "updateArtifact patches an existing record in place");

  commandCenterStore.deleteArtifact(id1);
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 0, "deleteArtifact removes the record");

  commandCenterStore.resetAll();
  for (let i = 0; i < 35; i++) commandCenterStore.saveArtifact(draftForHistory);
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 30, "Artifact History is bounded to 30 records — oldest evicted first, same discipline as snapshotHistory/memoryEvents");

  commandCenterStore.resetAll();
  commandCenterStore.bumpUsage("surface:test-key");
  commandCenterStore.bumpUsage("surface:test-key");
  commandCenterStore.bumpUsage(artifactUsageKey("STATUS_UPDATE"));
  commandCenterStore.bumpUsage(commandUsageKey("create-status-update"));
  const usageSnapshot = commandCenterStore.getSnapshot().usageCounters;
  ok("V2.2 Usage (store)", usageSnapshot["surface:test-key"] === 2, "bumpUsage increments an existing counter");
  const usageSummary = computeUsageSummary(usageSnapshot);
  ok("V2.2 Usage (store)", usageSummary.mostUsedArtifactType?.label === "Status Update", "computeUsageSummary surfaces the most-used artifact type from the bounded counter map");
  ok("V2.2 Usage (store)", usageSummary.unusedSurfaces.length > 0, "a surface never bumped this session correctly shows up as unused, never fabricated as used");

  commandCenterStore.resetAll();
}


// ----- parseStoredState corruption safety (artifacts + usageCounters) -----
{
  const corrupted = parseStoredState(JSON.stringify({ artifacts: "not-an-array", usageCounters: { good: 5, bad1: "not-a-number", bad2: -1 } }));
  ok("V2.2 Corruption safety", Array.isArray(corrupted.artifacts) && corrupted.artifacts.length === 0, "a non-array 'artifacts' field falls back to an empty array rather than crashing");
  ok("V2.2 Corruption safety", corrupted.usageCounters.good === 5, "a valid counter entry survives parseStoredState");
  ok("V2.2 Corruption safety", corrupted.usageCounters.bad1 === undefined && corrupted.usageCounters.bad2 === undefined, "a non-numeric or negative counter entry is dropped, never trusted as-is");

  const mixedArtifacts = parseStoredState(
    JSON.stringify({
      artifacts: [
        { id: "malformed-missing-fields" },
        { id: "v22-ok", type: "STATUS_UPDATE", createdAt: TODAY, sections: [], evidence: [], evidenceVersion: "v1" },
      ],
    })
  );
  ok("V2.2 Corruption safety", mixedArtifacts.artifacts.length === 1 && mixedArtifacts.artifacts[0].id === "v22-ok", "a malformed artifact entry is dropped while a well-formed sibling entry is kept — never a crash, never a fabricated field");
}


// ===== V2.2.1 — Production Completion & Deployment Readiness =====

// ----- §14/§21 — LOOP_STALLED must not duplicate on every close/sync while a loop remains
// stalled (previously it did, risking crowding out real signal in the bounded 200-event
// memory log for any pilot with a genuinely long-stuck loop). -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const projectId = commandCenterStore.getSnapshot().data.projects[0]?.id ?? "p-1";
  commandCenterStore.addDecision({ projectId, title: "V2.2.1 loop-dedup test decision", status: "DECIDED", description: "test decision with no follow-up action — deterministically STALLED" });

  await commandCenterStore.closeDay();
  const afterFirst = commandCenterStore.getSnapshot().memoryEvents.filter((e) => e.kind === "LOOP_STALLED" && e.title.includes("V2.2.1 loop-dedup test decision"));
  ok("V2.2.1 Memory event dedup", afterFirst.length === 1, "closing the day once logs exactly one LOOP_STALLED event for the newly-stalled loop");

  await commandCenterStore.closeDay();
  const afterSecond = commandCenterStore.getSnapshot().memoryEvents.filter((e) => e.kind === "LOOP_STALLED" && e.title.includes("V2.2.1 loop-dedup test decision"));
  ok("V2.2.1 Memory event dedup", afterSecond.length === 1, "closing the day again while the SAME loop remains stalled does not add a duplicate LOOP_STALLED event");

  commandCenterStore.resetAll();
}


// ----- §4/§5 — Jira fetch calls carry an explicit abort timeout, so a hung Jira instance
// fails fast into the existing network-error classification instead of hanging until the
// platform kills the function. -----
{
  ok("V2.2.1 Jira timeout", typeof AbortSignal.timeout === "function", "the runtime supports AbortSignal.timeout, which jira/http.ts now attaches to every real fetch call");
  const httpSource = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/jira/http.ts"), "utf8");
  const timeoutCallSites = (httpSource.match(/signal: AbortSignal\.timeout\(JIRA_FETCH_TIMEOUT_MS\)/g) ?? []).length;
  ok(
    "V2.2.1 Jira timeout",
    // V2.10 §2 adds one legitimate new real fetch call site (fetchIssueCommentsWith), which
    // also attaches the timeout — this count is a deliberately-updated magic number, not a
    // relaxed guard: every real fetch call site, old or new, must still attach one.
    timeoutCallSites === 6,
    `all 6 real Jira fetch call sites (projects, jql issue search, classic issue search fallback, changelog, capability probe, issue comments) attach the timeout signal (found ${timeoutCallSites})`
  );
}


// ----- §4 — jira/status and jira/conformance GET routes must be force-dynamic. Without it,
// Next.js statically optimizes a parameter-less GET handler and serves ONE response frozen
// at `next build` time for the route's entire production lifetime — meaning a user who
// configures Jira credentials AFTER deploying would see "not configured" forever, and the
// "Run Conformance Check" button would silently replay a build-time-frozen report. -----
{
  for (const routeFile of ["src/app/api/command-center/jira/status/route.ts", "src/app/api/command-center/jira/conformance/route.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), routeFile), "utf8");
    ok("V2.2.1 Route dynamic rendering", /export const dynamic = "force-dynamic"/.test(source), `${routeFile} declares force-dynamic — without it this parameter-less GET route would be statically frozen at build time`);
  }
}


// ===== V2.2.2 — real production bug fix: Jira Cloud now answers the classic
// GET /rest/api/3/search endpoint with 410 Gone (Atlassian sunset it in favor of
// POST /rest/api/3/search/jql). fetchJiraIssuesWith now tries the replacement endpoint
// first and only falls back to classic search on a 404 from the replacement itself. =====
{
  const jqlConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // ----- The fix: a modern Jira Cloud instance (jql endpoint works, classic is 410 Gone if
  // ever called) must be fetched successfully via the new endpoint, never touching classic. -----
  {
    let classicCalled = false;
    let jqlCallCount = 0;
    const modernCloudFetch: FetchLike = async (url, init) => {
      if (url.includes("/search/jql")) {
        jqlCallCount++;
        const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { nextPageToken?: string };
        if (!body.nextPageToken) {
          const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `JPMC-${i}` }));
          return { ok: true, status: 200, json: async () => ({ issues, nextPageToken: "page-2-token", isLast: false }) };
        }
        const issues = Array.from({ length: 10 }, (_, i) => makeJiraIssue({ key: `JPMC-page2-${i}` }));
        return { ok: true, status: 200, json: async () => ({ issues, isLast: true }) };
      }
      if (url.includes("/search")) {
        classicCalled = true;
        return { ok: false, status: 410, json: async () => ({ errorMessages: ["fixture: classic search is Gone"] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(modernCloudFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", result.ok && result.recordsFetched === JIRA_PAGE_SIZE + 10, `a modern Jira Cloud instance is fetched successfully via /search/jql, across cursor pages (got ${result.ok ? result.recordsFetched : "error"})`);
    ok("V2.2.2 Jira search migration", result.ok && result.method === "jql-cursor", "the successful result records that the cursor-based endpoint was actually used");
    ok("V2.2.2 Jira search migration", jqlCallCount === 2, "cursor pagination followed nextPageToken across exactly 2 pages");
    ok("V2.2.2 Jira search migration", !classicCalled, "the classic (410 Gone) endpoint is never called when the replacement endpoint works — this is the actual bug fix");
  }

  // ----- An instance that genuinely doesn't expose the replacement endpoint (404 on the very
  // first page) falls back to classic search, which still works there. -----
  {
    const legacyInstanceFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
      if (url.includes("/search")) {
        const startAt = Number(new URL(url).searchParams.get("startAt"));
        const issues = Array.from({ length: 5 }, (_, i) => makeJiraIssue({ key: `LEGACY-${startAt + i}` }));
        return { ok: true, status: 200, json: async () => ({ issues, startAt, maxResults: JIRA_PAGE_SIZE, total: 5 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(legacyInstanceFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", result.ok && result.recordsFetched === 5, "a 404 on the very first /search/jql page falls back to classic search for the whole fetch");
    ok("V2.2.2 Jira search migration", result.ok && result.method === "classic-offset", "the fallback result honestly records that the classic endpoint was actually used");
  }

  // ----- The real-world failure this bug report reproduced: neither endpoint works. Must
  // surface a clear, non-crashing error — never silently return zero issues as if the
  // project were simply empty. -----
  {
    const brokenInstanceFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 410, json: async () => ({ errorMessages: ["Gone"] }) };
    };
    const result = await fetchJiraIssuesWith(brokenInstanceFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", !result.ok, "when both the replacement and classic endpoints fail, the fetch honestly fails rather than returning an empty-looking success");
    ok("V2.2.2 Jira search migration", !result.ok && /deprecated|Gone/.test(result.error), `the 410 failure message is specific and actionable, not a generic "unexpected status" (got: ${!result.ok ? result.error : ""})`);
  }

  // ----- A non-404 failure on the replacement endpoint (real auth/permission/rate-limit
  // problem) must surface immediately — never mask a real credential issue with a silent
  // fallback attempt. -----
  {
    const authFailOnJql: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 401, json: async () => ({}) };
      throw new Error("classic endpoint must never be called for a 401 on the replacement endpoint");
    };
    const result = await fetchJiraIssuesWith(authFailOnJql, jqlConfig, {});
    ok("V2.2.2 Jira search migration", !result.ok && result.errorKind === "auth-failure", "a 401 on the replacement endpoint is classified as auth-failure immediately, with no fallback attempt that could mask it");
  }

  ok("V2.2.2 Jira search migration", classifyHttpError(410).error.includes("410") || /deprecated|Gone/i.test(classifyHttpError(410).error), "classifyHttpError(410) gives a specific, actionable message distinguishing it from a generic unrecognized status");
}


// ===== V2.2.3 — real production bug fix #2: after migrating to /search/jql, real sync
// started failing with 400 Bad Request. Root cause: that endpoint strictly validates every
// requested field name and rejects the WHOLE request if one doesn't resolve on the instance
// (the classic endpoint silently ignored unrecognized fields instead) — and "flagged" is
// documented as an instance-specific custom field, not a universal system field, so it's
// the one entry that could legitimately fail this validation on a real site. =====
{
  const fieldsConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // ----- The actual fix: "flagged" is never requested from the strict endpoint. -----
  {
    let requestedFields: string[] | undefined;
    const captureFieldsFetch: FetchLike = async (url, init) => {
      if (url.includes("/search/jql")) {
        const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { fields?: string[] };
        requestedFields = body.fields;
        return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await fetchJiraIssuesWith(captureFieldsFetch, fieldsConfig, {});
    ok("V2.2.3 Jira field validation", Array.isArray(requestedFields) && !requestedFields.includes("flagged"), "the strict /search/jql endpoint is never asked for 'flagged' — the one field known not to be a universal system field");
    ok(
      "V2.2.3 Jira field validation",
      Array.isArray(requestedFields) && ["summary", "status", "priority", "assignee", "duedate", "labels", "fixVersions", "issuetype", "issuelinks", "project", "created", "updated"].every((f) => requestedFields!.includes(f)),
      "every genuine universal system field is still requested — only the one instance-specific field was dropped"
    );
  }

  // ----- The debuggability fix: Jira's own validation message is surfaced, not swallowed. -----
  {
    const rejectedFieldFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) {
        return { ok: false, status: 400, json: async () => ({ errorMessages: [], errors: { fields: "The value 'flagged' does not exist for the field 'fields'." } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(rejectedFieldFetch, fieldsConfig, {});
    ok("V2.2.3 Jira error surfacing", !result.ok, "a 400 from the strict endpoint fails the fetch");
    ok(
      "V2.2.3 Jira error surfacing",
      !result.ok && result.error.includes("does not exist for the field"),
      `Jira's actual validation message is included in the surfaced error, not just a generic status code (got: ${!result.ok ? result.error : ""})`
    );
  }

  // ----- errorMessages[] (the other real Jira error shape) is also surfaced. -----
  {
    const errorMessagesFetch: FetchLike = async (url) => {
      if (url.includes("/project/search")) return { ok: false, status: 400, json: async () => ({ errorMessages: ["The JQL you have entered is not valid."] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraProjectsWith(errorMessagesFetch, fieldsConfig);
    ok("V2.2.3 Jira error surfacing", !result.ok && result.error.includes("The JQL you have entered is not valid."), "errorMessages[] entries are surfaced the same way errors{} entries are");
  }

  // ----- A response body that isn't the expected error shape (or isn't JSON at all) never
  // crashes — the status-based message alone still stands. -----
  {
    const nonJsonErrorFetch: FetchLike = async () => ({ ok: false, status: 400, json: async () => { throw new Error("Unexpected token < in JSON"); } });
    const result = await fetchJiraProjectsWith(nonJsonErrorFetch, fieldsConfig);
    ok("V2.2.3 Jira error surfacing", !result.ok && result.error.length > 0, "an unparseable error body (e.g. an HTML error page) never throws — the status-based message alone is used");
  }

  ok("V2.2.3 Jira error surfacing", classifyHttpError(400).error.includes("400"), "classifyHttpError(400) gives a specific 'malformed request' message rather than a generic unrecognized-status message");
}


// ===== V2.2.4 — real production bug fix #3: after fixing the 400 on the "flagged" field,
// real sync started failing with a DIFFERENT 400: "Unbounded JQL queries are not allowed
// here. Please add a search restriction to your query." Root cause: /rest/api/3/search/jql
// rejects a JQL with no WHERE clause at all (`order by ...` alone) — exactly what
// buildIssuesJql produced for a first sync with no JIRA_PROJECT_KEYS configured (the common
// case, since that variable is optional). =====
{
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({}) === "project is not EMPTY order by updated asc", "no scope and no incremental cursor still produces a JQL with a real WHERE clause — never a bare 'order by' that Jira's endpoint rejects as unbounded");
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({ projectKeys: ["JPMC"] }) === 'project in ("JPMC") order by updated asc', "a real project scope is used as-is — the bounded-query workaround only applies when there's genuinely no other restriction");
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({ sinceIso: "2026-08-01" }) === 'updated >= "2026-08-01" order by updated asc', "an incremental sinceIso is already a real bounding clause — the workaround clause is not redundantly added");
  ok("V2.2.4 Jira bounded JQL", !buildIssuesJql({}).startsWith("order by"), "the unbounded case never starts with a bare ORDER BY");

  // End-to-end: a fetch that would reject an unbounded JQL with exactly the real-world
  // message must now succeed, because the JQL we send is no longer unbounded.
  const boundedConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };
  let sentJql: string | undefined;
  const strictInstanceFetch: FetchLike = async (url, init) => {
    if (url.includes("/search/jql")) {
      const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { jql?: string };
      sentJql = body.jql;
      if (!body.jql || body.jql.trim().toLowerCase().startsWith("order by")) {
        return { ok: false, status: 400, json: async () => ({ errorMessages: ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."] }) };
      }
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const result = await fetchJiraIssuesWith(strictInstanceFetch, boundedConfig, {});
  ok("V2.2.4 Jira bounded JQL", result.ok, `a first full sync against an instance that enforces bounded JQL now succeeds (got ${result.ok ? "ok" : "error: " + (result as { error?: string }).error})`);
  ok("V2.2.4 Jira bounded JQL", sentJql === "project is not EMPTY order by updated asc", "the exact JQL sent to a real instance matches the bounded-query workaround");
}
