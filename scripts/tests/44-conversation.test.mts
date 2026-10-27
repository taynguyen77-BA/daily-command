// P3.2 — ball-in-court: conversation state rules, bounded enrichment, cache, merge, chip/nudge agreement.
import fs from "node:fs";
import path from "node:path";
import { computeConversationState, conversationChip, needsNudge, nudgeList, waitingDays, type ConversationState } from "../../src/lib/command-center/conversation-state";
import { conversationEnrichCap, selectConversationCandidates } from "../../src/lib/command-center/conversation-select";
import { enrichConversations } from "../../src/lib/command-center/conversation-enrich";
import { asConversationStates, conversationCacheOf, mergeConversationStates } from "../../src/lib/command-center/conversation-store";
import { rowMatchesConversationFilter } from "../../src/lib/command-center/conversation-filter";
import { buildAwaitingMe } from "../../src/lib/command-center/awaiting-me";
import { scoreWorkItem } from "../../src/lib/command-center/scoring";
import { fetchRecentCommentsWith, type FetchLike } from "../../src/lib/command-center/jira/http";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";

const ME = "acc-me";
const today = "2026-10-27"; // Tuesday
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const text = (t: string, mention?: string) => ({ type: "doc", content: [{ type: "paragraph", content: [...(mention ? [{ type: "mention", attrs: { id: mention } }] : []), { type: "text", text: t }] }] });
const c = (by: string, created: string, mention?: string) => ({ created, author: { accountId: by, displayName: by === ME ? "Me" : by }, body: text("x", mention) });
const state = (comments: ReturnType<typeof c>[], over: { assignee?: string; open?: boolean; accountId?: string | undefined } = {}) =>
  computeConversationState({ comments, accountId: "accountId" in over ? over.accountId : ME, assigneeAccountId: over.assignee, open: over.open ?? true, today, issueUpdatedAt: "2026-10-27T08:00:00.000Z" });

{
  const group = "P3.2 Awaiting rules";
  const table: [string, ReturnType<typeof state>["awaiting"], ReturnType<typeof state>][] = [
    ["a comment mentions me, I never replied", "ME", state([c("bob", "2026-10-26T09:00:00.000Z", ME)])],
    ["I am the assignee and someone commented after my last comment", "ME", state([c(ME, "2026-10-20T09:00:00.000Z"), c("bob", "2026-10-26T09:00:00.000Z")], { assignee: ME })],
    ["someone commented, not mentioning me, I am not the assignee", "NONE", state([c("bob", "2026-10-26T09:00:00.000Z")])],
    ["they mentioned me but I replied after (today)", "NONE", state([c("bob", "2026-10-24T09:00:00.000Z", ME), c(ME, "2026-10-27T06:00:00.000Z")])],
    ["my reply is the newest and it is a business day old", "THEM", state([c("bob", "2026-10-22T09:00:00.000Z", ME), c(ME, "2026-10-26T09:00:00.000Z")])],
    ["my reply is the newest but from today", "NONE", state([c("bob", "2026-10-22T09:00:00.000Z"), c(ME, "2026-10-27T07:00:00.000Z")])],
    ["my reply Friday evening, today Tuesday (3 calendar days, 2 business days)", "THEM", state([c(ME, "2026-10-23T17:00:00.000Z")])],
    ["closed ticket", "NONE", state([c("bob", "2026-10-26T09:00:00.000Z", ME)], { open: false })],
    ["missing accountId", "NONE", state([c("bob", "2026-10-26T09:00:00.000Z", ME)], { accountId: undefined })],
    ["no comments", "NONE", state([])],
  ];
  for (const [name, want, got] of table) ok(group, got.awaiting === want, `${name} -> ${want} (got ${got.awaiting})`);
  const me = state([c("bob", "2026-10-26T09:00:00.000Z", ME), c("amy", "2026-10-24T09:00:00.000Z", ME)]);
  ok(group, me.sinceAt === "2026-10-24T09:00:00.000Z" && me.lastByName === "bob" && me.lastExternalAt === "2026-10-26T09:00:00.000Z" && !me.lastIsMe && me.issueUpdatedAt === "2026-10-27T08:00:00.000Z", "fields: sinceAt is the oldest unanswered comment that concerns me; last*/lastExternal*/issueUpdatedAt filled");
  const them = state([c(ME, "2026-10-26T09:00:00.000Z"), c("bob", "2026-10-22T09:00:00.000Z")]);
  ok(group, them.lastIsMe && them.myLastAt === "2026-10-26T09:00:00.000Z" && them.sinceAt === "2026-10-26T09:00:00.000Z", "awaiting them: sinceAt is my comment");
  ok(group, JSON.stringify(state([c("bob", "2026-10-26T09:00:00.000Z", ME), c(ME, "2026-10-20T09:00:00.000Z")])) === JSON.stringify(state([c(ME, "2026-10-20T09:00:00.000Z"), c("bob", "2026-10-26T09:00:00.000Z", ME)])), "the result does not depend on the order the comments arrive in");
  ok(group, waitingDays(me, today) === 3 && waitingDays(state([]), today) === undefined, "waitingDays counts calendar days since sinceAt");
}

{
  const group = "P3.2 Candidate selection and the request cap";
  const items = Array.from({ length: 60 }, (_, i) => ({ key: `P-${i}`, status: i % 11 === 0 ? "Done" : "In Progress", blocked: i % 7 === 0, ownerId: i % 3 === 0 ? ME : "other" }));
  const updated = Object.fromEntries(items.map((w) => [w.key, "2026-10-27T08:00:00.000Z"]));
  const base = { workItems: items, accountId: ME, mentionedKeys: ["P-1", "P-2", "P-0"], topKeys: ["P-50", "P-51"], issueUpdatedByKey: updated, cache: undefined as Record<string, string> | undefined, cap: 25 };
  const sel = selectConversationCandidates(base);
  ok(group, sel.length === 25 && new Set(sel).size === 25, `never more than the cap (25): ${sel.length}`);
  ok(group, sel[0] === "P-1" && sel[1] === "P-2" && !sel.includes("P-0"), "mentioned tickets come first; Done tickets are never fetched (P-0 is Done)");
  ok(group, selectConversationCandidates({ ...base, cap: 3 }).length === 3 && selectConversationCandidates({ ...base, cap: 0 }).length === 0, "the cap is honoured; 0 turns it off");
  const cache = Object.fromEntries(sel.map((k) => [k, updated[k]]));
  const afterCache = selectConversationCandidates({ ...base, cache });
  ok(group, afterCache.every((k) => !sel.includes(k)) && afterCache.length <= 25, "cached tickets with an unchanged `updated` are not selected again and do not consume the cap");
  ok(group, selectConversationCandidates({ ...base, cache: { "P-1": "2026-10-26T00:00:00.000Z" } }).includes("P-1"), "a ticket whose `updated` moved is fetched again");
  ok(group, conversationEnrichCap({}) === 25 && conversationEnrichCap({ CONVERSATION_ENRICH_CAP: "10" }) === 10 && conversationEnrichCap({ CONVERSATION_ENRICH_CAP: "0" }) === 0 && conversationEnrichCap({ CONVERSATION_ENRICH_CAP: "500" }) === 25 && conversationEnrichCap({ CONVERSATION_ENRICH_CAP: "x" }) === 25, "CONVERSATION_ENRICH_CAP: 0-100, default 25");

  // the enrichment as the sync runs it, with a counting fake
  let requests = 0;
  const fetchComments = async () => { requests++; return { ok: true as const, data: [c("bob", "2026-10-26T09:00:00.000Z", ME)] as never }; };
  const run = await enrichConversations({ ...base, assigneeByKey: new Map(), today, concurrency: 5 }, fetchComments);
  ok(group, requests === 25 && run.requested === 25 && Object.keys(run.conversation).length === 25 && run.conversation["P-1"].awaiting === "ME", `a sync makes at most CONVERSATION_ENRICH_CAP comment requests (${requests})`);
  requests = 0;
  const cachedRun = await enrichConversations({ ...base, cache: Object.fromEntries(items.map((w) => [w.key, updated[w.key]])), assigneeByKey: new Map(), today, concurrency: 5 }, fetchComments);
  ok(group, requests === 0 && cachedRun.requested === 0 && Object.keys(cachedRun.conversation).length === 0, "when everything is cached there are zero requests");
  requests = 0;
  const late = await enrichConversations({ ...base, assigneeByKey: new Map(), today, concurrency: 2, deadline: 0 }, fetchComments);
  ok(group, requests === 0 && late.skipped === 25, "past the deadline nothing is requested and the skipped count is reported (-> partial)");
  const failing = await enrichConversations({ ...base, cap: 3, assigneeByKey: new Map(), today, concurrency: 2 }, async () => ({ ok: false as const }));
  ok(group, Object.keys(failing.conversation).length === 0, "a failed comment fetch leaves that ticket without a state (best effort)");

  const urls: URL[] = [];
  const fakeJira: FetchLike = async (url) => { urls.push(new URL(url)); return { ok: true, status: 200, json: async () => ({ comments: [], total: 0 }) }; };
  await fetchRecentCommentsWith(fakeJira, { baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t" }, "K-1", 5);
  ok(group, urls.length === 1 && urls[0].searchParams.get("orderBy") === "-created" && urls[0].searchParams.get("maxResults") === "5", "the fetch is one request: orderBy=-created&maxResults=5");

  const route = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /conversationCache: z\.record/.test(route) && /enrichConversations\(/.test(route) && /if \(requestAccountId\) \{[\s\S]{0,400}issueUpdatedByKey/.test(route), "the route takes the client's cache keys, and only enriches when an accountId was sent");
}

{
  const group = "P3.2 Client state";
  const fresh: Record<string, ConversationState> = { "A-1": { lastIsMe: false, awaiting: "ME", sinceAt: "2026-10-26T09:00:00.000Z", issueUpdatedAt: "u1" }, "A-2": { lastIsMe: true, awaiting: "THEM", issueUpdatedAt: "u2" }, "GONE-1": { lastIsMe: false, awaiting: "ME", issueUpdatedAt: "u3" } };
  const open = [{ key: "A-1", status: "In Progress" }, { key: "A-2", status: "Blocked" }, { key: "A-3", status: "Done" }];
  const merged = mergeConversationStates({ "A-3": { lastIsMe: false, awaiting: "ME" }, "A-2": { lastIsMe: false, awaiting: "NONE" } }, fresh, open);
  ok(group, Object.keys(merged).sort().join() === "A-1,A-2" && merged["A-2"].awaiting === "THEM", "fresh states override cached ones; states for Done / vanished tickets are pruned");
  ok(group, Object.keys(mergeConversationStates({ "A-1": fresh["A-1"] }, undefined, open)).join() === "A-1", "no conversation in the response keeps the cache (still pruned)");
  ok(group, Object.keys(mergeConversationStates(undefined, undefined, open)).length === 0, "a sync without an accountId / conversation field changes nothing");
  ok(group, JSON.stringify(conversationCacheOf(fresh)) === JSON.stringify({ "A-1": "u1", "A-2": "u2", "GONE-1": "u3" }) && Object.keys(conversationCacheOf({ x: { lastIsMe: false, awaiting: "NONE" } })).length === 0, "the request cache is key -> updatedAt only (never content)");
  ok(group, Object.keys(asConversationStates({ ok: fresh["A-1"], bad: { awaiting: "MAYBE" }, worse: 5, list: [] })).join() === "ok" && Object.keys(asConversationStates(undefined)).length === 0 && Object.keys(asConversationStates([1])).length === 0, "a malformed blob is dropped entry by entry");
  const old = JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira" });
  ok(group, Object.keys(parseStoredState(old).conversationByTicket ?? { x: 1 }).length === 0, "an old stored state (no conversationByTicket) loads as empty");
  const roundTrip = parseStoredState(JSON.stringify({ ...JSON.parse(old), conversationByTicket: fresh }));
  ok(group, roundTrip.conversationByTicket?.["A-1"]?.awaiting === "ME", "a stored conversationByTicket round-trips");
  const syncedKeys = read("src/lib/command-center/app-state.ts") + read("src/lib/command-center/store.ts").slice(read("src/lib/command-center/store.ts").indexOf("toSyncedState"), read("src/lib/command-center/store.ts").indexOf("toSyncedState") + 4000);
  ok(group, !/conversationByTicket/.test(syncedKeys), "it is derived, device-local data: not part of the cross-device sync blob");
}

{
  const group = "P3.2 Chip, nudge list, filter and the score factor agree";
  const SLA = 2;
  const convo: Record<string, ConversationState> = {
    "N-1": { lastIsMe: true, awaiting: "THEM", sinceAt: "2026-10-21T09:00:00.000Z" }, // 4 business days -> nudge
    "N-2": { lastIsMe: true, awaiting: "THEM", sinceAt: "2026-10-26T09:00:00.000Z" }, // 1 business day -> chip, no nudge
    "N-3": { lastIsMe: true, awaiting: "THEM", sinceAt: "2026-10-23T09:00:00.000Z" }, // exactly 2 business days -> not past SLA
    "M-1": { lastIsMe: false, awaiting: "ME", sinceAt: "2026-10-25T09:00:00.000Z" },
    "Z-1": { lastIsMe: false, awaiting: "NONE" },
  };
  const tickets = Object.keys(convo).map((k) => ({ key: k, title: `Title ${k}` }));
  const list = nudgeList(convo, tickets, today, SLA);
  ok(group, list.map((r) => r.ticketKey).join() === "N-1", `only tickets past the SLA are in "Needs a nudge" (${list.map((r) => r.ticketKey).join() || "none"})`);
  for (const t of tickets) ok(group, (conversationChip(convo[t.key], today, SLA)?.nudge ?? false) === list.some((r) => r.ticketKey === t.key) && needsNudge(convo[t.key], today, SLA) === list.some((r) => r.ticketKey === t.key), `${t.key}: the chip's nudge flag and the list agree`);
  ok(group, conversationChip(convo["N-1"], today, SLA)?.text === "Awaiting them · 6d" && conversationChip(convo["M-1"], today, SLA)?.text === "Awaiting you · 2d" && conversationChip({ ...convo["M-1"], sinceAt: "2026-10-27T01:00:00.000Z" }, today, SLA)?.text === "Awaiting you · today" && conversationChip(convo["Z-1"], today, SLA) === null && conversationChip(undefined, today, SLA) === null, "chip text");
  ok(group, list[0].draftRow.isUnknownPerson && list[0].draftRow.person === "UNKNOWN" && /N-1/.test(list[0].draftRow.what) && /4 business day/.test(list[0].draftRow.why), "the draft uses the blocker follow-up row shape and never guesses a recipient");
  const count = (f: "all" | "awaiting-me" | "awaiting-them") => Object.values(convo).filter((x) => rowMatchesConversationFilter(f, x)).length;
  ok(group, count("all") === 5 && count("awaiting-me") === 1 && count("awaiting-them") === 3, "filter: all 5, awaiting-me 1, awaiting-them 3")
  ok(group, rowMatchesConversationFilter("all", undefined) && !rowMatchesConversationFilter("awaiting-me", undefined), "a ticket with no conversation state only matches 'all'");

  // feeds Score v2's Awaiting-you factor
  const item = { id: "jira-M-1", key: "M-1", title: "t", projectId: "p", clientId: "c", type: "task", status: "In Progress", priority: "P3", createdDate: "2026-10-01", lastUpdated: today, blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, owner: "Tay" } as never;
  const withConvo = scoreWorkItem(item, { ...emptyData(), workItems: [item] }, today, { model: "v2", awaitingMeByKey: buildAwaitingMe([], {}, convo) });
  const without = scoreWorkItem(item, { ...emptyData(), workItems: [item] }, today, { model: "v2", awaitingMeByKey: buildAwaitingMe([], {}) });
  ok(group, withConvo.factors.find((f) => f.name === "Awaiting you")!.contribution > 0 && without.factors.find((f) => f.name === "Awaiting you")!.contribution === 0, "an AWAITING_ME conversation feeds the Awaiting-you score factor");
  const both = buildAwaitingMe([{ issueKey: "M-1", commentId: "c", mentionedAt: "2026-10-20" }], {}, convo);
  ok(group, both["M-1"].sinceIso === "2026-10-20" && both["M-1"].count === 1 && !("N-1" in both), "mention + conversation: the oldest wait wins and the mention is not double-counted; awaiting-them never counts");
}

{
  const group = "P3.2 UI wiring";
  ok(group, /ConversationChipView/.test(read("src/components/command-center/TaskReferenceRow.tsx")) && /conversationByTicket/.test(read("src/components/command-center/TaskReferenceRow.tsx")), "the chip renders on the connected TaskRow");
  const page = read("src/app/my-work/page.tsx");
  ok(group, /NeedsNudgeGroup/.test(page) && /rowMatchesConversationFilter/.test(page) && /data-conversation-filter/.test(page), "My Work has the filter and the Needs-a-nudge group");
  ok(group, /nudgeList\(/.test(read("src/components/command-center/ConversationChip.tsx")) && /renderNeedsFromOthersText/.test(read("src/components/command-center/ConversationChip.tsx")), "the group is built by nudgeList and drafts with the shared follow-up renderer");
}
