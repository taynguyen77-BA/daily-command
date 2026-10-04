// V2.37 I1–I4 — task-level AI features on the V2.36 foundation: Ticket Brief, Smart Triage,
// Mention Reply Drafter, audience-aware reports. Offline: the model, Jira and the store are
// fakes; outgoing browser requests are captured with a stubbed globalThis.fetch.

import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";
import type { IssueContext } from "../../src/lib/command-center/jira/issue-context";
import { DEFAULT_AI_DATA_PROTECTION, type AiDataProtectionSettings } from "../../src/lib/command-center/ai/data-protection";
import { handleAiRequest, ResponseCache, type ModelCallParams, type ModelCallResult, type AiServerDeps } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger } from "../../src/lib/command-center/ai/usage-ledger";
import { aiTaskTier } from "../../src/lib/command-center/ai/model-config";
import { buildTicketAiInput } from "../../src/lib/command-center/ai/data-protection";
import { openTicketBrief, applyBriefSuggestion, isBriefStale, AI_SUGGESTED_PREFIX, type StoredTicketBrief } from "../../src/lib/command-center/ai/ticket-brief";
import { applyTriageSelection, buildTriageInput, defaultChecked, deferDatesFor, normalizeTriage, triageAcceptance, addTriageStats, groupByCategory, type TriageCandidate, type TriageSuggestion } from "../../src/lib/command-center/ai/smart-triage";
import { draftMentionReplyFlow, memoryDraftCache, mentionReplyCacheKey, DEFAULT_REPLY_OPTIONS } from "../../src/lib/command-center/ai/mention-reply";
import { clientSafeDailyView, isInternalNote, rewriteReportFlow, rewriteSource, dropClientSections } from "../../src/lib/command-center/ai/report-rewrite";
import { lockedFactViolations } from "../../src/lib/command-center/ai/task-registry";
import { planJiraReply, executeJiraWriteBack } from "../../src/lib/command-center/jira/write-back";
import { applyTicketStatus } from "../../src/lib/command-center/ticket-work-state";
import { ClaudeProvider, clearAiBudgetStatus } from "../../src/lib/command-center/ai/claude-provider";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { DEFAULT_FEATURE_TOGGLES, DEFAULT_JIRA_WRITE_BACK_SETTINGS, type TicketWorkState, type TicketWorkStatus, type TicketStatusSurface } from "../../src/lib/command-center/types";
import type { DailyReportView } from "../../src/lib/command-center/reports";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const TODAY = "2026-10-05"; // a Monday
const NOW = new Date("2026-10-05T09:00:00.000Z");

function ctx(key: string, over: Partial<IssueContext> = {}): IssueContext {
  return {
    key,
    projectKey: key.split("-")[0],
    summary: "Statement export for Acme Bank",
    status: "In Progress",
    updated: "2026-10-04T10:00:00.000+0000",
    description: "Users need CSV export. Contact jane@acme.com.",
    comments: [
      { author: "Priya Shah", created: "2026-10-03T09:00:00.000Z", body: "Is PDF in scope too? Waiting on the bank's API spec." },
      { author: "Tom Lee", created: "2026-10-04T08:30:00.000Z", body: "@Tay can you confirm the column order by Friday?" },
    ],
    links: [{ key: "PAY-9", summary: "Statement API", status: "To Do", relation: "is blocked by" }],
    statusHistory: [],
    fetchedAt: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}
const settings: AiDataProtectionSettings = { ...DEFAULT_AI_DATA_PROTECTION, allowedProjectKeys: ["PAY"], customTerms: [{ term: "Acme Bank", alias: "Client A" }], previewSeenProjects: { PAY: "2026-10-01T00:00:00.000Z" } };

function fakeModel(answers: string[]) {
  const calls: ModelCallParams[] = [];
  return {
    calls,
    callModel: async (p: ModelCallParams): Promise<ModelCallResult> => {
      calls.push(JSON.parse(JSON.stringify(p)));
      return { stopReason: "end_turn", text: answers[Math.min(calls.length - 1, answers.length - 1)], usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}
const deps = (m: ReturnType<typeof fakeModel>): AiServerDeps => ({ env: {}, callModel: m.callModel, ledger: new MemoryUsageLedger(), now: () => NOW, cache: new ResponseCache() });

/** A store-shaped fake over the real pure status write, so history entries are real. */
function fakeStatusStore() {
  let states: Record<string, TicketWorkState> = {};
  const calls: { key: string; status: TicketWorkStatus; surface: TicketStatusSurface; reason?: string; until?: string }[] = [];
  const seen: string[] = [];
  const stats: { day: string; rows: { category: string; accepted: boolean }[] }[] = [];
  return {
    calls,
    seen,
    stats,
    get states() {
      return states;
    },
    setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }) {
      calls.push({ key, status, ...opts });
      const r = applyTicketStatus(states, key, status, opts, NOW.toISOString());
      states = r.states;
      return r.changed;
    },
    markDailyReviewSeen(keys: string[]) {
      seen.push(...keys);
    },
    recordTriageAcceptance(day: string, rows: { category: "Reply needed" | "Review needed" | "Do" | "FYI"; accepted: boolean }[]) {
      stats.push({ day, rows });
    },
  };
}

{
  const group = "V2.37 Toggles";
  ok(group, !DEFAULT_FEATURE_TOGGLES.ticketBrief && !DEFAULT_FEATURE_TOGGLES.smartTriage && !DEFAULT_FEATURE_TOGGLES.mentionReplyDrafter && !DEFAULT_FEATURE_TOGGLES.audienceReports, "all four features are off by default");
  const ds = read("src/app/data-settings/page.tsx");
  ok(group, ["ticketBrief", "smartTriage", "mentionReplyDrafter", "audienceReports"].every((k) => ds.includes(`key: "${k}"`)), "each has a switch in Data & Settings → Features");
  const readme = read("README.md");
  ok(group, /Ticket Brief/.test(readme) && /Smart triage/i.test(readme) && /Mention reply/i.test(readme) && /Rewrite for/.test(readme), "README documents all four");
}

// ===== I1 Ticket Brief =====
{
  const group = "V2.37 I1 Ticket Brief";
  const built = buildTicketAiInput(ctx("PAY-1"), settings);
  const input = { ticket: built.allowed ? built.input : undefined, today: TODAY };
  const good = { whatIsAsked: "CSV export of statements.", currentState: "In Progress; Tom Lee asked about column order.", waitingOn: [{ who: "Priya Shah", what: "Bank API spec" }], openQuestions: ["Is PDF in scope too?"], suggestedNextStep: "Confirm the column order with Tom Lee.", suggestedStatus: { status: "BLOCKED", reason: "Waiting on PAY-9" } };
  const r1 = await handleAiRequest({ task: "generateTicketBrief", input }, deps(fakeModel([JSON.stringify(good)])));
  ok(group, r1.status === 200, "a brief citing only the ticket's people, keys and dates passes");
  const invented = { ...good, waitingOn: [{ who: "Marcus", what: "sign-off" }] };
  const m2 = fakeModel([JSON.stringify(invented)]);
  const r2 = await handleAiRequest({ task: "generateTicketBrief", input }, deps(m2));
  ok(group, r2.status === 422 && (r2.body.violations as string[]).some((v) => v.includes("Marcus")) && m2.calls.length === 2, "a waitingOn person not named in the ticket is rejected (after one retry)");
  const m3 = fakeModel([JSON.stringify({ ...good, suggestedNextStep: "Close PAY-77 first." })]);
  const r3 = await handleAiRequest({ task: "generateTicketBrief", input }, deps(m3));
  ok(group, r3.status === 422 && (r3.body.violations as string[]).some((v) => v.includes("PAY-77")), "an invented ticket key is rejected");
  ok(group, aiTaskTier("generateTicketBrief") === "default", "brief runs on the default (mid-cost) tier");

  // Cache: re-opening the same unchanged ticket = 0 model calls, 0 Jira fetches.
  let modelCalls = 0;
  let loads = 0;
  const provider = { mode: "claude" as const, generateTicketBrief: async () => (modelCalls++, good as never) };
  const loadContext = async () => (loads++, { ok: true as const, context: ctx("PAY-1") });
  const first = await openTicketBrief({ key: "PAY-1", workItemUpdated: "2026-10-04", cache: {}, settings, today: TODAY, nowIso: NOW.toISOString(), loadContext, provider });
  ok(group, first.kind === "generated" && modelCalls === 1 && first.stored.updated === "2026-10-04T10:00:00.000+0000", "first open generates a brief keyed by the issue's `updated`");
  const cache = first.kind === "generated" ? { "PAY-1": first.stored } : {};
  const again = await openTicketBrief({ key: "PAY-1", workItemUpdated: "2026-10-04", cache, settings, today: TODAY, loadContext, provider });
  ok(group, again.kind === "cached" && !again.stale && modelCalls === 1 && loads === 1, "re-opening the unchanged ticket uses the cache: 0 model calls, no refetch");
  const changed = await openTicketBrief({ key: "PAY-1", workItemUpdated: "2026-10-05", cache, settings, today: TODAY, loadContext, provider });
  ok(group, changed.kind === "cached" && changed.stale && modelCalls === 1, "a ticket updated since shows the stored brief marked 'updated since brief' (still 0 calls)");
  const regen = await openTicketBrief({ key: "PAY-1", workItemUpdated: "2026-10-05", cache, settings, today: TODAY, regenerate: true, loadContext, provider });
  ok(group, regen.kind === "generated" && modelCalls === 2, "Regenerate makes a new brief");
  const blocked = await openTicketBrief({ key: "OPS-1", cache: {}, settings, today: TODAY, loadContext, provider });
  ok(group, blocked.kind === "disabled" && loads === 2, "a project outside the allow-list: 'AI disabled', nothing fetched or sent");
  const firstUse = await openTicketBrief({ key: "PAY-1", cache: {}, settings: { ...settings, previewSeenProjects: {} }, today: TODAY, loadContext, provider });
  ok(group, firstUse.kind === "needs-preview" && modelCalls === 2, "first use per project shows 'What will be sent' before any call");
  const restored = await openTicketBrief({ key: "PAY-1", cache: {}, settings, today: TODAY, loadContext, provider: { mode: "claude", generateTicketBrief: async () => ({ ...good, whatIsAsked: "Client A wants CSV." }) as never } });
  ok(group, restored.kind === "generated" && restored.stored.brief.whatIsAsked === "Acme Bank wants CSV.", "aliases in the brief are restored for display");
  ok(group, isBriefStale({ updated: "2026-10-04T10:00:00Z" } as StoredTicketBrief, "2026-10-05") && !isBriefStale({ updated: "2026-10-04T10:00:00Z" } as StoredTicketBrief, "2026-10-04"), "stale = synced ticket updated on a later day than the brief's content");

  // Suggested status: only a click, through setTicketStatus.
  const store = fakeStatusStore();
  ok(group, store.calls.length === 0, "showing a brief changes nothing");
  applyBriefSuggestion(store, "PAY-1", { status: "BLOCKED", reason: "Waiting on PAY-9" }, TODAY);
  const h = store.states["PAY-1"].history.at(-1);
  ok(group, store.calls.length === 1 && h?.surface === "ai-brief" && h?.reason === `${AI_SUGGESTED_PREFIX}Waiting on PAY-9`, "clicking the suggestion is the normal status change, recorded as ai-brief / AI-suggested");
  applyBriefSuggestion(store, "PAY-2", { status: "DEFERRED", reason: "Next sprint" }, TODAY);
  ok(group, store.states["PAY-2"].until === "2026-10-06", "a defer suggestion defers to tomorrow");

  const mock = await new MockAIProvider().generateTicketBrief(built.allowed ? built.input : (undefined as never), TODAY);
  ok(group, mock.openQuestions.some((q) => q.includes("Is PDF in scope too?")) && mock.waitingOn.length === 0 && !mock.suggestedStatus, "the deterministic brief only restates the ticket (questions from the thread, no suggestions)");
  const row = read("src/components/command-center/TaskReferenceRow.tsx");
  ok(group, /w\?\.sourceType === "jira" && \(state\.features\.ticketBrief/.test(row) && /state\.features\.ticketBrief && <TicketBrief/.test(row) && /<TaskRow[^>]*ticketKey=\{candidate\.ticketKey\}/.test(read("src/components/command-center/FocusSession.tsx")), "Brief is on every Jira TaskRow (and Focus Session's ticket row)");
}

// ===== I2 Smart Triage =====
{
  const group = "V2.37 I2 Smart Triage";
  const candidates: TriageCandidate[] = [
    { key: "PAY-1", title: "Export for Acme Bank", type: "Story", status: "To Do", signal: "assigned to you", role: "assigned", lastCommentExcerpt: "Tom: please review jane@acme.com's spec " + "x".repeat(400) },
    { key: "OPS-7", title: "Rotate certs", type: "Task", status: "To Do", signal: "mentioned", role: "mentioned", lastCommentExcerpt: "Secret ops detail that must not leave" },
  ];
  const { input, session, metadataOnlyKeys } = buildTriageInput(candidates, settings, TODAY);
  const ops = input.items.find((i) => i.key === "OPS-7")!;
  const pay = input.items.find((i) => i.key === "PAY-1")!;
  ok(group, ops.lastCommentExcerpt === undefined && metadataOnlyKeys.includes("OPS-7"), "items from non-allowed projects are triaged from metadata only (no comment text)");
  ok(group, !!pay.lastCommentExcerpt && pay.lastCommentExcerpt.length <= 300 && !pay.lastCommentExcerpt.includes("jane@acme.com") && pay.title.includes("Client A"), "allowed items carry a redacted excerpt ≤ 300 chars");
  ok(group, aiTaskTier("triageNewItems") === "fast", "one batched call on the fast tier");
  ok(group, deferDatesFor(TODAY).join() === "2026-10-06,2026-10-07,2026-10-12", "defer may only use tomorrow / the day after / next Monday (a week out on a Monday)");

  // The outgoing request. (An earlier suite may have left "budget used up today" set.)
  clearAiBudgetStatus();
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") return new Response(JSON.stringify({ available: true }), { status: 200 });
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ ok: true, data: { items: [
      { key: "PAY-1", category: "Review needed", action: { kind: "defer", until: "2026-10-06" }, confidence: 0.8, rationale: "Client A spec to review" },
      { key: "OPS-7", category: "FYI", action: { kind: "skip", reason: "Ops handles it" }, confidence: 0.4, rationale: "Mention only" },
    ] }, usage: { cap: 1000, remainingToday: 900 } }), { status: 200 });
  }) as typeof fetch;
  let raw: TriageSuggestion[] = [];
  try {
    raw = await new ClaudeProvider().triageNewItems(input);
  } finally {
    globalThis.fetch = originalFetch;
  }
  ok(group, bodies.length === 1 && !bodies[0].includes("Secret ops detail") && !bodies[0].includes("jane@acme.com") && !bodies[0].includes("Acme Bank"), "the one outgoing request has no comment text for non-allowed projects and nothing unredacted");

  const store = fakeStatusStore();
  const list = normalizeTriage(["PAY-1", "OPS-7", "PAY-3"], raw, session);
  ok(group, list.length === 3 && list[2].key === "PAY-3" && list[2].confidence === 0 && list[0].rationale === "Acme Bank spec to review", "one suggestion per New item (missing → cautious keep); aliases restored");
  ok(group, defaultChecked(list[0]) && !defaultChecked(list[1]) && !defaultChecked(list[2]), "low-confidence suggestions default unchecked");
  ok(group, groupByCategory(list).map((g) => g.category).join() === "Review needed,FYI", "grouped by category");
  ok(group, store.calls.length === 0 && store.seen.length === 0, "0 state changes before Apply is clicked");

  const selected = new Set(list.filter(defaultChecked).map((s) => s.key));
  const r = applyTriageSelection(store, list, selected, TODAY);
  ok(group, r.applied.join() === "PAY-1" && store.calls.length === 1 && store.calls[0].status === "DEFERRED" && store.calls[0].until === "2026-10-06", "Apply changes only the ticked items, through setTicketStatus");
  const hist = store.states["PAY-1"].history.at(-1)!;
  ok(group, hist.surface === "ai-triage" && hist.reason!.startsWith("AI-suggested"), "history entries show surface 'ai-triage' and an 'AI-suggested' reason");
  ok(group, !store.states["OPS-7"] && store.seen.join() === "PAY-1", "unticked items are untouched");

  // Acceptance stats.
  ok(group, store.stats.length === 1 && store.stats[0].rows.length === 3 && store.stats[0].rows.filter((x) => x.accepted).length === 1, "acceptance is recorded per shown suggestion");
  let stats = addTriageStats({}, TODAY, store.stats[0].rows as never);
  stats = addTriageStats(stats, "2026-10-01", [{ category: "Review needed", accepted: false }]);
  stats = addTriageStats(stats, "2026-09-20", [{ category: "Do", accepted: true }]);
  const week = triageAcceptance(stats, "2026-09-29", TODAY);
  const review = week.find((x) => x.category === "Review needed")!;
  ok(group, review.suggested === 2 && review.accepted === 1 && review.rate === 0.5 && !week.some((x) => x.category === "Do"), "Weekly Review rate per category over the last 7 days");
  ok(group, /features\.smartTriage && <TriageAcceptance/.test(read("src/app/weekly-review/page.tsx")), "the rates are shown in Weekly Review");

  // Server-side checks on the batched answer.
  const bad = JSON.stringify({ items: [{ key: "PAY-1", category: "Do", action: { kind: "defer", until: "2026-12-25" }, confidence: 0.9, rationale: "x" }, { key: "PAY-404", category: "FYI", action: { kind: "keep" }, confidence: 0.2, rationale: "y" }] });
  const m = fakeModel([bad, bad]);
  const rr = await handleAiRequest({ task: "triageNewItems", input }, deps(m));
  const v = (rr.body.violations as string[]) ?? [];
  ok(group, rr.status === 422 && v.some((x) => x.includes("PAY-404")) && v.some((x) => x.includes("defer date")), "an unknown item or an invented defer date is rejected");
  const mockList = await new MockAIProvider().triageNewItems(input);
  ok(group, mockList.every((x) => x.action.kind === "keep" && !defaultChecked(x)), "without AI: cautious 'keep' suggestions, all unticked");
  const mm = read("src/components/command-center/MorningMode.tsx");
  ok(group, /state\.features\.smartTriage && <SmartTriagePanel/.test(mm), "Smart triage sits in Morning Mode step 2");
}

// ===== I3 Mention Reply Drafter =====
{
  const group = "V2.37 I3 Mention reply";
  const mention = { issueKey: "PAY-1", commentId: "c2", author: "Tom Lee", excerpt: "@Tay can you confirm the column order by Friday?", mentionedAt: "2026-10-04T08:30:00.000Z" };
  const calls: { language: string; tone: string; body: string }[] = [];
  const provider = {
    mode: "claude" as const,
    draftMentionReply: async (i: { language: string; tone: string; mention: { body: string } }) => {
      calls.push({ language: i.language, tone: i.tone, body: i.mention.body });
      return { reply: i.language === "vi" ? "Chào Tom Lee, thứ tự cột như mô tả." : "Hi Tom Lee, the column order is as described.", unansweredPoints: ["Friday deadline"] };
    },
  };
  const cache = memoryDraftCache();
  const fixed = (c: IssueContext) => async () => ({ ok: true as const, context: c, fromCache: false });
  const base = { loadContext: fixed(ctx("PAY-1")), mention, settings, provider, cache };
  const a = await draftMentionReplyFlow({ ...base, options: DEFAULT_REPLY_OPTIONS });
  ok(group, a.kind === "done" && !a.fromCache && calls.length === 1 && calls[0].body.includes("column order by Friday"), "drafts from the comment thread (the full mention comment)");
  const same = await draftMentionReplyFlow({ ...base, options: DEFAULT_REPLY_OPTIONS });
  ok(group, same.kind === "done" && same.fromCache && calls.length === 1, "same options → the cached draft");
  const vi = await draftMentionReplyFlow({ ...base, options: { ...DEFAULT_REPLY_OPTIONS, language: "vi" } });
  const client = await draftMentionReplyFlow({ ...base, options: { ...DEFAULT_REPLY_OPTIONS, tone: "client" } });
  ok(group, vi.kind === "done" && !vi.fromCache && client.kind === "done" && !client.fromCache && calls.length === 3 && calls[1].language === "vi" && calls[2].tone === "client", "a language or tone switch produces a new draft");
  ok(group, new Set([DEFAULT_REPLY_OPTIONS, { ...DEFAULT_REPLY_OPTIONS, language: "vi" as const }, { ...DEFAULT_REPLY_OPTIONS, tone: "client" as const }, { ...DEFAULT_REPLY_OPTIONS, length: "short" as const }].map((o) => mentionReplyCacheKey(mention, "u", o))).size === 4, "each option set has its own cache key");
  const off = await draftMentionReplyFlow({ ...base, loadContext: fixed(ctx("OPS-1")), mention: { ...mention, issueKey: "OPS-1" }, options: DEFAULT_REPLY_OPTIONS });
  ok(group, off.kind === "disabled" && calls.length === 3, "non-allowed project: nothing is sent");
  ok(group, aiTaskTier("draftMentionReply") === "default", "default tier");

  // Posting: only through write-back, with preview + confirm + gate.
  const ws = { ...DEFAULT_JIRA_WRITE_BACK_SETTINGS, projects: ["PAY"] };
  ok(group, planJiraReply({ features: { jiraWriteBack: false }, settings: ws, ticketKey: "PAY-1", text: "Hi", mentionCommentId: "c2" }) === null, "write-back off → no post offered (copy only)");
  ok(group, planJiraReply({ features: { jiraWriteBack: true }, settings: ws, ticketKey: "OPS-1", text: "Hi", mentionCommentId: "c2" }) === null, "project not on the write-back allow-list → no post offered");
  const proposal = planJiraReply({ features: { jiraWriteBack: true }, settings: ws, ticketKey: "PAY-1", text: "Hi Tom", mentionCommentId: "c2" })!;
  ok(group, proposal.trigger === "reply" && proposal.writes.length === 1 && proposal.writes[0].kind === "comment" && proposal.mentionCommentId === "c2", "Post to Jira proposes one comment for the confirmation dialog");
  const sent: unknown[] = [];
  const notConfirmed = await executeJiraWriteBack(proposal, { comment: false }, async (r) => (sent.push(r), { ok: true }), () => {});
  ok(group, sent.length === 0 && !notConfirmed.commentPosted, "nothing is posted unless the comment is confirmed in the dialog");
  const confirmed = await executeJiraWriteBack(proposal, { comment: true, commentText: "Hi Tom, edited" }, async (r) => (sent.push(r), { ok: true }), () => {});
  ok(group, confirmed.commentPosted && JSON.stringify(sent[0]).includes("Hi Tom, edited"), "the confirmed (edited) text is what gets posted");
  const dlg = read("src/components/command-center/JiraWriteBackPrompt.tsx");
  ok(group, /proposal\.trigger === "reply" && proposal\.mentionCommentId && r\.commentPosted\) commandCenterStore\.markMentionReplied/.test(dlg), "a posted reply marks the mention replied");
  const drafter = read("src/components/command-center/MentionReplyDrafter.tsx");
  ok(group, /proposeJiraReply\(/.test(drafter) && !/sendJiraWrite|jira-write-client/.test(drafter), "the drafter never posts directly — only via the write-back dialog (server gate unchanged)");
  ok(group, /<MentionReplyDrafter/.test(read("src/components/command-center/RecentlyMentioned.tsx")), "'Draft reply' is on mention rows");
}

// ===== I4 Audience-aware reports =====
{
  const group = "V2.37 I4 Rewrite reports";
  const view = {
    date: TODAY,
    doneMine: [{ key: "PAY-1", title: "Export", notes: ["via Daily Command"] }],
    inProgress: [{ key: "PAY-2", title: "Import", notes: ["in progress"] }],
    blocked: [{ key: "PAY-3", title: "API", notes: ["[internal] vendor is slow, chase Bob"], assignee: "Bob Ray" }, { key: "PAY-4", title: "Docs", notes: ["Waiting on client sign-off"] }],
    skipped: [{ key: "PAY-5", title: "Old", notes: ["Not my action"] }],
    newToday: [],
    mentionsAwaitingReply: [{ key: "PAY-6", title: "Q", notes: ["Tom asked"] }],
    teamDone: [{ key: "PAY-7", title: "Team thing", assignee: "Ann" }],
    removedFromScope: [],
    decisions: [],
    standupAvailable: true,
    identityConfigured: true,
    summary: "3 done, 1 skipped",
    needsDecisionFrom: [{ person: "Bob Ray", items: ["API vendor"] }],
  } as unknown as DailyReportView;

  const client = rewriteSource({ kind: "daily", view }, "client", true);
  ok(group, !client.includes("PAY-7") && !/Team: done/.test(client), "client update excludes the Team section");
  ok(group, !client.includes("[internal]") && !client.includes("vendor is slow") && client.includes("Waiting on client sign-off"), "client update has no reason marked internal (other reasons stay)");
  ok(group, !client.includes("PAY-5") && !/Skipped/.test(client) && !client.includes("Not my action") && !client.includes("PAY-6"), "no skipped items or skip reasons, no mentions awaiting reply");
  ok(group, !client.includes("Bob Ray") && !client.includes("1 skipped"), "no teammates' names, no internal summary");
  ok(group, isInternalNote("internal: x") && isInternalNote("(internal) y") && isInternalNote("z #internal") && isInternalNote("Team is handling it") && !isInternalNote("Waiting on client"), "what counts as an internal note");
  ok(group, clientSafeDailyView(view).teamDone.length === 0 && dropClientSections("Skipped (2)\n- A\n- B\n\nDone (1)\n- C").trim() === "Done (1)\n- C", "client-safe view and section dropping");
  const team = rewriteSource({ kind: "daily", view }, "standup", true);
  ok(group, team.includes("PAY-7") && team.includes("PAY-5"), "the team versions keep everything");

  ok(group, lockedFactViolations("PAY-1 and PAY-2 done, 2 in total", "PAY-1 PAY-2 (2)").length === 0, "post-check: keys and numbers from the input pass");
  ok(group, lockedFactViolations("PAY-1 and PAY-99", "PAY-1").some((x) => x.includes("PAY-99")) && lockedFactViolations("4 tickets", "3 tickets").some((x) => x.includes("4")), "post-check: an added key or number fails");

  const fake = (out: string) => ({ mode: "claude" as const, rewriteReport: async () => out });
  const ok1 = await rewriteReportFlow({ source: team, audience: "pm", customTerms: [], provider: fake("Done: PAY-1. Blocked: PAY-3, PAY-4.") });
  ok(group, ok1.usedAi && !ok1.notice && ok1.text.startsWith("Done: PAY-1"), "a faithful rewrite is shown");
  const bad = await rewriteReportFlow({ source: team, audience: "pm", customTerms: [], provider: fake("Done: PAY-1 and PAY-42. 9 blockers.") });
  ok(group, !bad.usedAi && bad.text === team && /changed facts/.test(bad.notice ?? ""), "an invented key/number → the deterministic report with a notice");
  const down = await rewriteReportFlow({ source: team, audience: "vi", customTerms: [], provider: { mode: "mock", rewriteReport: async (_a: string, r: string) => r } });
  ok(group, !down.usedAi && down.text === team && !!down.notice, "AI unavailable → the deterministic report with a notice");
  let sentToModel = "";
  const aliased = await rewriteReportFlow({ source: "Done (1)\n- PAY-1 Export for Acme Bank", audience: "client", customTerms: [{ term: "Acme Bank", alias: "Client A" }], provider: { mode: "claude", rewriteReport: async (_a: string, r: string) => ((sentToModel = r), "We finished PAY-1, the export for Client A.") } });
  ok(group, !sentToModel.includes("Acme Bank") && aliased.text === "We finished PAY-1, the export for Acme Bank.", "client update runs redaction aliases (and restores them for display)");

  const m = fakeModel([JSON.stringify({ text: "PAY-1 done, plus 7 more." }), JSON.stringify({ text: "PAY-1 done, plus 7 more." })]);
  const rr = await handleAiRequest({ task: "rewriteReport", input: { audience: "pm", report: "Done (1)\n- PAY-1 Export" } }, deps(m));
  ok(group, rr.status === 422 && (rr.body.violations as string[]).some((x) => x.includes("7")), "the server applies the same locked-facts check");
  ok(group, /features\.audienceReports && <ReportRewrite/.test(read("src/app/reports/page.tsx")), "'Rewrite for…' is on the Reports page");
}
