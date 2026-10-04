// V2.39 review fixes K1–K6.
//   K1 mention reply drafter refetches a thread that predates (or lacks) the mention, labels an
//      excerpt-only draft, and a cached draft keeps the mode that produced it.
//   K2 WorkItem.updatedAt (Jira's full `updated`) makes same-day edits count as "updated since".
//   K3 the cron GET runs notify + snapshot only — never the discarded full sync.
//   K4 AI_ALLOWED_PROJECT_KEYS: server AI data policy on /jira/issue-context.
//   K5 (version line + legacy prompt path) is covered in 19-security-and-docs and 31-ai-foundation.
//   K6 Setup Health warns that the AI cap is per instance without KV.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";
import { makeJiraIssue } from "./helpers.mts";
import type { IssueContext } from "../../src/lib/command-center/jira/issue-context";
import { CommandCenterStore } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { loadIssueContext, isContextFresh } from "../../src/lib/command-center/ai/ticket-ai-client";
import { contextMissesMention, draftMentionReplyFlow, memoryDraftCache, mentionBody, mentionReplyCacheKey, DEFAULT_REPLY_OPTIONS, MENTION_NOT_FOUND_NOTICE } from "../../src/lib/command-center/ai/mention-reply";
import { DEFAULT_AI_DATA_PROTECTION, type AiDataProtectionSettings } from "../../src/lib/command-center/ai/data-protection";
import { isBriefStale, openTicketBrief, type StoredTicketBrief } from "../../src/lib/command-center/ai/ticket-brief";
import { compareJiraUpdated, workItemUpdatedStamp } from "../../src/lib/command-center/jira/updated-time";
import { normalizeIssue } from "../../src/lib/command-center/jira/normalize";
import { runCronTick } from "../../src/lib/command-center/jira/cron-tick";
import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { runServerDailySnapshot, createInMemoryServerReportStore } from "../../src/lib/command-center/server-daily-report";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { handleIssueContextRequest } from "../../src/lib/command-center/jira/issue-context-handler";
import { parseAiAllowedProjectKeys, AI_SERVER_POLICY_DENIED } from "../../src/lib/command-center/ai/server-policy";
import { buildAiStatusResponse } from "../../src/lib/command-center/ai/status-response";
import { computeSetupHealthRows, AI_CAP_WITHOUT_KV_WARNING } from "../../src/components/command-center/SetupHealthBanner";
import { buildWorkRelevanceIndex, DEFAULT_WORK_RELEVANCE_POLICY_MAP } from "../../src/lib/command-center/jira/work-relevance";
import { emptyData } from "../../src/lib/command-center/types";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const JIRA = { baseUrl: "https://fixture.invalid", email: "fixture@example.test", apiToken: "fixture-not-real" };

function ctx(over: Partial<IssueContext> = {}): IssueContext {
  return {
    key: "PAY-1",
    projectKey: "PAY",
    summary: "Statement export",
    status: "In Progress",
    updated: "2026-10-04T08:31:00.000+0000",
    description: "Users need CSV export.",
    comments: [
      { author: "Priya Shah", created: "2026-10-03T09:00:00.000Z", body: "Is PDF in scope too?" },
      { author: "Tom Lee", created: "2026-10-04T08:30:00.000Z", body: "@Tay can you confirm the column order by Friday? Full text beyond the excerpt." },
    ],
    links: [],
    statusHistory: [],
    fetchedAt: "2026-10-04T12:00:00.000Z",
    ...over,
  };
}
const settings: AiDataProtectionSettings = { ...DEFAULT_AI_DATA_PROTECTION, allowedProjectKeys: ["PAY"], previewSeenProjects: { PAY: "2026-10-01T00:00:00.000Z" } };
const mention = { issueKey: "PAY-1", commentId: "c2", author: "Tom Lee", excerpt: "@Tay can you confirm the column order…", mentionedAt: "2026-10-04T08:30:00.000Z" };

function recordingProvider(mode: "claude" | "mock") {
  const bodies: string[] = [];
  return {
    bodies,
    provider: {
      mode,
      draftMentionReply: async (i: { mention: { body: string } }) => {
        bodies.push(i.mention.body);
        return { reply: "Hi Tom Lee, the column order is as described.", unansweredPoints: [] };
      },
    },
  };
}

/** A real store + the real loadIssueContext, with the issue-context endpoint stubbed. */
async function withIssueContextEndpoint<T>(serverCtx: IssueContext, run: (store: CommandCenterStore, fetches: () => number) => Promise<T>): Promise<T> {
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("/api/command-center/jira/issue-context")) n++;
    return new Response(JSON.stringify({ ok: true, context: serverCtx }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(store, () => n);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ===== K1 — mention reply drafter uses the current thread =====
{
  const group = "V2.39 K1 Mention reply freshness";
  // Cached by an earlier Brief, BEFORE the mention was written: no mention comment, older `updated`.
  const stale = ctx({ updated: "2026-10-03T09:01:00.000+0000", comments: [ctx().comments[0]], fetchedAt: "2026-10-03T10:00:00.000Z" });
  ok(group, contextMissesMention(stale, mention) && !contextMissesMention(ctx(), mention), "a context older than the mention (or without its comment) is detected; the current one is not");

  await withIssueContextEndpoint(ctx(), async (store, fetches) => {
    store.cacheIssueContext(stale);
    const { provider, bodies } = recordingProvider("claude");
    const r = await draftMentionReplyFlow({ loadContext: (force) => loadIssueContext(store, "PAY-1", { force }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider, cache: memoryDraftCache() });
    ok(group, fetches() === 1, `context cached before the mention → drafting triggers exactly 1 issue-context fetch (got ${fetches()})`);
    ok(group, r.kind === "done" && !r.excerptOnly && bodies[0]?.includes("Full text beyond the excerpt"), "the draft is made from the full mention comment of the refetched thread");
    ok(group, store.getSnapshot().aiContextCache["PAY-1"]?.context.comments.length === 2, "the refetched thread replaces the stale cached copy");
  });

  await withIssueContextEndpoint(ctx(), async (store, fetches) => {
    store.cacheIssueContext(ctx());
    const { provider } = recordingProvider("claude");
    const r = await draftMentionReplyFlow({ loadContext: (force) => loadIssueContext(store, "PAY-1", { force }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider, cache: memoryDraftCache() });
    ok(group, fetches() === 0 && r.kind === "done" && !r.excerptOnly, "a cached thread that already contains the mention is used as is (0 fetches)");
  });

  // The thread (even freshly fetched) doesn't have the comment — e.g. it's beyond the last 20.
  const without = ctx({ comments: [ctx().comments[0]] });
  await withIssueContextEndpoint(without, async (store, fetches) => {
    store.cacheIssueContext(without);
    const { provider, bodies } = recordingProvider("claude");
    const r = await draftMentionReplyFlow({ loadContext: (force) => loadIssueContext(store, "PAY-1", { force }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider, cache: memoryDraftCache() });
    ok(group, fetches() === 1, "a cached thread missing the mention comment is refetched once");
    ok(group, r.kind === "done" && r.excerptOnly && bodies[0] === mention.excerpt, "still missing after the refetch → drafted from the excerpt and flagged excerptOnly");
  });
  await withIssueContextEndpoint(without, async (store, fetches) => {
    const { provider } = recordingProvider("claude");
    const r = await draftMentionReplyFlow({ loadContext: (force) => loadIssueContext(store, "PAY-1", { force }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider, cache: memoryDraftCache() });
    ok(group, fetches() === 1 && r.kind === "done" && r.excerptOnly, "nothing cached: one fetch, never a pointless second one, and the excerpt fallback is still flagged");
  });

  const drafter = read("src/components/command-center/MentionReplyDrafter.tsx");
  ok(group, /phase\.excerptOnly && \(/.test(drafter) && /\{MENTION_NOT_FOUND_NOTICE\}/.test(drafter) && /excerptOnly: r\.excerptOnly/.test(drafter), "the drafter shows the excerpt-only notice whenever the flow reports it");
  ok(group, MENTION_NOT_FOUND_NOTICE === "Mention comment not found in thread — draft based on excerpt only", "the notice text is exactly as specified");
  ok(group, mentionBody(ctx(), { ...mention, mentionedAt: "not a date" }).found === false, "an unparseable mentionedAt never throws — it is simply not found");

  // A cache hit reports the mode that produced the draft.
  const cache = memoryDraftCache();
  cache.set(mentionReplyCacheKey(mention, ctx().updated, DEFAULT_REPLY_OPTIONS), { draft: { reply: "Template reply", unansweredPoints: [] }, mode: "mock" });
  const claude = recordingProvider("claude");
  const hit = await draftMentionReplyFlow({ loadContext: async () => ({ ok: true, context: ctx(), fromCache: false }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider: claude.provider, cache });
  ok(group, hit.kind === "done" && hit.fromCache && hit.mode === "mock" && claude.bodies.length === 0, "a cached mock draft never reports mode 'claude' (even while Claude is the current provider)");
  const mockCache = memoryDraftCache();
  const mock = recordingProvider("mock");
  const first = await draftMentionReplyFlow({ loadContext: async () => ({ ok: true, context: ctx(), fromCache: false }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider: mock.provider, cache: mockCache });
  const again = await draftMentionReplyFlow({ loadContext: async () => ({ ok: true, context: ctx(), fromCache: false }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider: mock.provider, cache: mockCache });
  ok(group, first.kind === "done" && first.mode === "mock" && again.kind === "done" && !again.fromCache && again.mode === "mock", "a template draft isn't cached and always reports mock");
  const err = await draftMentionReplyFlow({ loadContext: async () => ({ ok: false, error: "HTTP 502" }), mention, options: DEFAULT_REPLY_OPTIONS, settings, provider: claude.provider, cache });
  ok(group, err.kind === "error" && err.message === "HTTP 502", "a load failure is reported, not drafted around");
}

// ===== K2 — intra-day staleness =====
{
  const group = "V2.39 K2 Intra-day staleness";
  const { workItem } = normalizeIssue(makeJiraIssue({ updated: "2026-10-04T15:00:00.000+0700" }), { today: "2026-10-04" });
  ok(group, workItem.lastUpdated === "2026-10-04" && workItem.updatedAt === "2026-10-04T15:00:00.000+0700", "lastUpdated keeps the day; updatedAt keeps Jira's full `updated`");
  ok(group, workItemUpdatedStamp(workItem) === workItem.updatedAt && workItemUpdatedStamp({ lastUpdated: "2026-10-04" }) === "2026-10-04", "the freshness stamp prefers updatedAt, falling back to lastUpdated for legacy items");
  ok(group, compareJiraUpdated("2026-10-04T15:00:00.000+0700", "2026-10-04T08:00:00.000Z") === 0 && compareJiraUpdated("2026-10-04T15:00:00.000+0700", "2026-10-04T10:00:00.000+0700") > 0, "full timestamps compare as instants, across offsets");

  // Brief at 10:00, new comment at 15:00 the same day.
  const brief: StoredTicketBrief = { key: "PAY-1", updated: "2026-10-04T10:00:00.000+0700", createdAt: "2026-10-04T03:05:00.000Z", mode: "claude", brief: { whatIsAsked: "x", currentState: "y", waitingOn: [], openQuestions: [], suggestedNextStep: "z" } };
  const opened = await openTicketBrief({
    key: "PAY-1",
    workItemUpdated: workItemUpdatedStamp(workItem),
    cache: { "PAY-1": brief },
    settings,
    today: "2026-10-04",
    loadContext: async () => ({ ok: false, error: "not called" }),
    provider: { mode: "mock", generateTicketBrief: async () => brief.brief },
  });
  ok(group, opened.kind === "cached" && opened.stale, 'Brief at 10:00, new comment 15:00 same day → "Updated since brief"');
  ok(group, !isBriefStale(brief, "2026-10-04T10:00:00.000+0700") && !isBriefStale(brief, "2026-10-04"), "same instant → not stale; a legacy date-only item on the same day keeps the old day rule");
  ok(group, isBriefStale(brief, "2026-10-05"), "a legacy item updated on a later day is still stale");
  const cached = ctx({ updated: "2026-10-04T10:00:00.000+0700" });
  ok(group, !isContextFresh(cached, "2026-10-04T15:00:00.000+0700") && isContextFresh(cached, "2026-10-04T10:00:00.000+0700") && isContextFresh(cached, "2026-10-04"), "cached ticket content: a same-day later edit refetches; equal or legacy same-day stays cached");
  const row = read("src/components/command-center/TaskReferenceRow.tsx");
  ok(group, /<TicketBrief ticketKey=\{key\} workItemUpdated=\{workItemUpdatedStamp\(w\)\} \/>/.test(row) && /workItemUpdated: workItemUpdatedStamp\(item\)/.test(read("src/components/command-center/TicketAiPanel.tsx")), "Brief, requirement check and Ticket AI all pass the full stamp");
}

// ===== K3 — the cron runs notify + snapshot only =====
{
  const group = "V2.39 K3 Cron without discarded sync";
  const ME = "acc-me";
  function recordingJira() {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
      if (/issue\/[^/]+\/comment/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ comments: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    return { fetchImpl, urls };
  }
  const NOW = new Date("2026-10-07T11:00:00.000Z"); // a Wednesday, after the snapshot hour
  const snapOpts = { now: NOW, timezoneOffsetMinutes: 0, snapshotHourLocal: 0 };

  const notifyAlone = recordingJira();
  await runServerSideNotifyCheck(notifyAlone.fetchImpl, JIRA, ME, createInMemoryNotifyStore());
  const snapAlone = recordingJira();
  await runServerDailySnapshot(snapAlone.fetchImpl, JIRA, ME, createInMemoryServerReportStore(), snapOpts);

  const cron = recordingJira();
  const result = await runCronTick(cron.fetchImpl, JIRA, ME, { notifyStore: createInMemoryNotifyStore(), snapshot: { store: createInMemoryServerReportStore(), ...snapOpts } });
  ok(group, result.ran.notify && result.ran.snapshot && result.warnings.length === 0, "both steps ran without warnings");
  ok(group, cron.urls.length === notifyAlone.urls.length + snapAlone.urls.length, `the cron makes exactly the requests notify (${notifyAlone.urls.length}) + snapshot (${snapAlone.urls.length}) need — ${cron.urls.length} in all`);
  ok(group, cron.urls.filter((u) => /\/changelog|\/rest\/api\/3\/project/.test(u)).length === 0, "0 changelog / project-list calls (the full sync's footprint)");
  const none = recordingJira();
  const skipped = await runCronTick(none.fetchImpl, JIRA, ME, {});
  ok(group, none.urls.length === 0 && !skipped.ran.notify && !skipped.ran.snapshot, "with neither store configured the cron makes no Jira call at all");

  const route = read("src/app/api/command-center/jira/sync/route.ts");
  const getHandler = route.slice(route.indexOf("export async function GET"));
  ok(group, !/POST\(/.test(getHandler) && !/fetchJiraIssues|fetchJiraProjects|fetchJiraIssueChangelog/.test(getHandler), "the GET handler never calls POST or any full-sync fetch");
  ok(group, /export async function POST\(req: Request\)/.test(route) && /fetchJiraIssues\(config/.test(route), "POST (browser Sync Now) is unchanged");
}

// ===== K4 — server-side AI data policy =====
{
  const group = "V2.39 K4 Server AI policy";
  ok(group, parseAiAllowedProjectKeys(undefined) === null && parseAiAllowedProjectKeys("  ") === null, "unset / blank → no server restriction");
  ok(group, JSON.stringify(parseAiAllowedProjectKeys(" pay, OPS ,bad key,PAY")) === '["PAY","OPS"]', "a comma list is trimmed, upper-cased, de-duplicated; junk is dropped");
  ok(group, JSON.stringify(parseAiAllowedProjectKeys("??")) === "[]", "set but all-invalid → allows nothing (never 'everything')");

  const call = async (key: string, env: string | undefined) => {
    let jira = 0;
    const r = await handleIssueContextRequest(new URL(`https://app.test/api/command-center/jira/issue-context?key=${key}`), {
      configured: true,
      jiraProjectKeys: null,
      aiAllowedProjectKeys: env,
      fetchIssueContext: async () => {
        jira++;
        return { ok: true, data: ctx({ key, projectKey: key.split("-")[0] }), recordsFetched: 1 };
      },
    });
    return { ...r, jira };
  };
  const denied = await call("OPS-1", "PAY");
  ok(group, denied.status === 403 && denied.jira === 0 && denied.body.error === AI_SERVER_POLICY_DENIED, "an issue outside AI_ALLOWED_PROJECT_KEYS → 403, no Jira call made");
  const allowed = await call("PAY-1", "PAY,OPS");
  ok(group, allowed.status === 200 && allowed.jira === 1, "an allowed project is fetched as before");
  const open = await call("OPS-1", undefined);
  ok(group, open.status === 200 && open.jira === 1, "unset → unchanged behaviour (the client allow-list alone decides)");
  const jiraScope = await handleIssueContextRequest(new URL("https://app.test/x?key=OPS-1"), { configured: true, jiraProjectKeys: ["PAY"], aiAllowedProjectKeys: undefined, fetchIssueContext: async () => ({ ok: false, error: "x", errorKind: "unknown" }) });
  ok(group, jiraScope.status === 403, "JIRA_PROJECT_KEYS still applies too");
  const routeSrc = read("src/app/api/command-center/jira/issue-context/route.ts");
  ok(group, /aiAllowedProjectKeys: process\.env\.AI_ALLOWED_PROJECT_KEYS/.test(routeSrc) && /handleIssueContextRequest\(/.test(routeSrc), "the route wires the env var through the tested handler");

  const env = { AI_ALLOWED_PROJECT_KEYS: "PAY" };
  ok(group, !("aiAllowedProjectKeys" in buildAiStatusResponse(env, { available: true, kvConfigured: true, authorized: false })), "an unauthenticated status call doesn't learn the project keys");
  ok(group, JSON.stringify(buildAiStatusResponse(env, { available: true, kvConfigured: true, authorized: true }).aiAllowedProjectKeys) === '["PAY"]' && buildAiStatusResponse({}, { available: true, kvConfigured: true, authorized: true }).aiAllowedProjectKeys === null, "a paired caller sees the server policy (null = unset)");
  const panel = read("src/components/command-center/AiDataProtectionPanel.tsx");
  ok(group, /data-ai-server-policy/.test(panel) && /AI_ALLOWED_PROJECT_KEYS/.test(panel) && /blocked by server/.test(panel) && !/setAiServer|store\.set.*serverPolicy/.test(panel), "Data & Settings shows the server policy read-only next to the personal allow-list");
}

// ===== K5 — README no longer documents the removed flag =====
{
  const group = "V2.39 K5 Legacy path docs";
  const readme = read("README.md");
  ok(group, !/\| `AI_LEGACY_PROMPT_PATH`/.test(readme) && /\| `AI_ALLOWED_PROJECT_KEYS`/.test(readme), "the env table drops AI_LEGACY_PROMPT_PATH and documents AI_ALLOWED_PROJECT_KEYS");
}

// ===== K6 — the cap without KV =====
{
  const group = "V2.39 K6 Cap without KV";
  const idx = buildWorkRelevanceIndex(DEFAULT_WORK_RELEVANCE_POLICY_MAP);
  const fine = { configured: true, serverSideNotifyActive: true } as never;
  const rows = (ai: Parameters<typeof computeSetupHealthRows>[5]["ai"]) => computeSetupHealthRows(undefined, "demo", emptyData(), idx, fine, { ai }).filter((r) => r.id === "ai-cap-kv");
  const shown = rows({ available: true, modelFromEnv: true, fastModelFromEnv: true, capStorage: "memory" });
  ok(group, shown.length === 1 && shown[0].text === AI_CAP_WITHOUT_KV_WARNING && AI_CAP_WITHOUT_KV_WARNING === "AI daily cap is per server instance — configure KV to enforce it", "ANTHROPIC_API_KEY set, KV not → the warning, word for word");
  ok(group, rows({ available: true, capStorage: "kv" }).length === 0 && rows({ available: false, capStorage: "memory" }).length === 0 && rows(null).length === 0 && rows({ available: true }).length === 0, "hidden with KV, without an API key, while loading, or from an older server");
  ok(group, buildAiStatusResponse({}, { available: true, kvConfigured: false, authorized: false }).capStorage === "memory", "the status endpoint reports where the cap is counted");
}
