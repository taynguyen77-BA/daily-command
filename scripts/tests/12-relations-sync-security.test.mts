// V2.13–V2.18 — ticket links, personal relation, cross-device sync, route security
// Run through scripts/tests/run.mts (npm test).

import { emptyData } from "../../src/lib/command-center/types";
import { parseStoredState, commandCenterStore, type StoreState } from "../../src/lib/command-center/store";
import type { Decision } from "../../src/lib/command-center/types";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { Action } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import type { PersonalPlanItem } from "../../src/lib/command-center/types";
import type { MentionEvent } from "../../src/lib/command-center/types";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketLink } from "../../src/components/command-center/TicketLink";
import { classifyPersonalRelation, isMyActionItem, matchesIdentity } from "../../src/lib/command-center/personal-relation";
import { RelationBadge } from "../../src/components/command-center/ui";
import { checkSyncRequestAuth } from "../../src/lib/command-center/jira/sync-auth";
import { checkAppStateAuth, createInMemoryAppStateStore, isAppStateStoreConfigured, syncedAppStateSchema, type SyncedAppState } from "../../src/lib/command-center/app-state";
import { decideInitialSync, extractSyncedAppState, looksUnused, mergeSyncedAppState } from "../../src/lib/command-center/app-state-sync";
import { daysStale } from "../../src/components/command-center/Header";
import { ok } from "./harness.mts";
import { TODAY, jiraItem, makeDecision, makeItem } from "./helpers.mts";

// ===== V2.13 §3 — TicketLink: real link when a real Jira sourceUrl exists, plain text when
// it doesn't; never a fabricated href guessed from the key pattern. No jsdom in this project
// (see the V1.8 Accessibility section above) — rendered via react-dom/server's
// renderToStaticMarkup, a real DOM-structure check, not just "doesn't throw". =====
{
  const withUrl = renderToStaticMarkup(React.createElement(TicketLink, { ticketKey: "JPMC-123", url: "https://jira.example.com/browse/JPMC-123" }));
  ok("V2.13 TicketLink", /<a\b[^>]*\bhref="https:\/\/jira\.example\.com\/browse\/JPMC-123"/.test(withUrl), "with a url, TicketLink renders an <a> with that exact href");
  ok("V2.13 TicketLink", /target="_blank"/.test(withUrl) && /rel="noopener noreferrer"/.test(withUrl), "the link opens in a new tab with noopener noreferrer");
  ok("V2.13 TicketLink", withUrl.includes("JPMC-123"), "the ticket key text is rendered inside the link");

  const withoutUrl = renderToStaticMarkup(React.createElement(TicketLink, { ticketKey: "JPMC-124" }));
  ok("V2.13 TicketLink", !/<a[\s>]/.test(withoutUrl), "with no url, TicketLink renders no <a> tag at all — plain text, never a broken/empty link");
  ok("V2.13 TicketLink", withoutUrl.includes("JPMC-124"), "the plain ticket key text is still rendered");
}


// ===== V2.14 §1 — classifyPersonalRelation: all five outcomes, with/without accountId
// configured (fallback path), and the no-identity-at-all -> UNKNOWN case. =====
{
  const item = makeItem({ id: "cr-wi-1", key: "CR-1", owner: "Alice", ownerId: "acc-alice" });
  const mentioned = new Set(["CR-1"]);
  const notMentioned = new Set<string>();

  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, {}, notMentioned, item.key) === "UNKNOWN", "no accountId/displayName configured at all -> UNKNOWN, never guessed (§1)");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, {}, mentioned, item.key) === "UNKNOWN", "UNKNOWN holds even when the issue IS in mentionedIssueKeys — no identity means no relation can be claimed");

  // accountId-configured path.
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-alice" }, notMentioned, item.key) === "ASSIGNED", "ownerId matches the configured accountId, not mentioned -> ASSIGNED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-alice" }, mentioned, item.key) === "ASSIGNED_AND_MENTIONED", "ownerId matches AND the issue is mentioned -> ASSIGNED_AND_MENTIONED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, mentioned, item.key) === "MENTIONED", "ownerId does not match, but the issue is mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, notMentioned, item.key) === "FOLLOWING", "neither assigned nor mentioned, but identity IS configured -> FOLLOWING, not UNKNOWN");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, mentioned, undefined) === "FOLLOWING", "an undefined issueKey never matches mentionedIssueKeys, even when the set is non-empty");

  // displayName-fallback path (no accountId configured).
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Alice" }, notMentioned, item.key) === "ASSIGNED", "no accountId configured -> falls back to WorkItem.owner === identity.displayName");
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Bob" }, mentioned, item.key) === "MENTIONED", "displayName fallback: no name match, but mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Alice" }, mentioned, item.key) === "ASSIGNED_AND_MENTIONED", "displayName fallback: name match AND mentioned -> ASSIGNED_AND_MENTIONED");

  // accountId takes priority over displayName — a shared display name is never enough once
  // accountId is configured (same discipline as V2.10 §1's isExplicitOwner).
  const impostor = makeItem({ id: "cr-wi-2", key: "CR-2", owner: "Alice", ownerId: "acc-impostor" });
  ok(
    "V2.14 classifyPersonalRelation — accountId priority",
    classifyPersonalRelation(impostor, { accountId: "acc-alice", displayName: "Alice" }, notMentioned, impostor.key) === "FOLLOWING",
    "accountId configured -> a matching displayName alone is never enough (no name-similarity guessing)"
  );

  // No related WorkItem at all (personal-focus.ts's relation-less stub) — still resolves a
  // real value, never a crash, and mention-only signals still work with no owner info.
  const noOwnerStub = { id: "stub", ownerId: undefined, owner: undefined };
  ok("V2.14 classifyPersonalRelation — no related work item", classifyPersonalRelation(noOwnerStub, { accountId: "acc-alice" }, mentioned, "CR-1") === "MENTIONED", "no ownerId/owner at all, but the issue key is mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation — no related work item", classifyPersonalRelation(noOwnerStub, { accountId: "acc-alice" }, notMentioned, "CR-1") === "FOLLOWING", "no ownerId/owner at all and not mentioned -> FOLLOWING");

  // matchesIdentity — the shared comparison isExplicitOwner (personal-focus.ts) also calls.
  ok("V2.14 matchesIdentity", matchesIdentity("acc-1", "Alice", { accountId: "acc-1" }) === true, "ownerId match wins when accountId is configured");
  ok("V2.14 matchesIdentity", matchesIdentity("acc-2", "Alice", { accountId: "acc-1" }) === false, "a different ownerId never matches, regardless of displayName");
  ok("V2.14 matchesIdentity", matchesIdentity(undefined, "Alice", { displayName: "Alice" }) === true, "displayName match when no accountId is configured");
  ok("V2.14 matchesIdentity", matchesIdentity(undefined, undefined, {}) === false, "nothing to compare -> false, never a guessed match");
}


// ===== V2.14 §4 — isMyActionItem: ASSIGNED/ASSIGNED_AND_MENTIONED/MENTIONED only. =====
{
  ok("V2.14 isMyActionItem", isMyActionItem("ASSIGNED") === true, "ASSIGNED counts as a my-action item");
  ok("V2.14 isMyActionItem", isMyActionItem("ASSIGNED_AND_MENTIONED") === true, "ASSIGNED_AND_MENTIONED counts");
  ok("V2.14 isMyActionItem", isMyActionItem("MENTIONED") === true, "MENTIONED counts — someone is waiting on a reply");
  ok("V2.14 isMyActionItem", isMyActionItem("FOLLOWING") === false, "FOLLOWING is excluded — visibility only, not a task");
  ok("V2.14 isMyActionItem", isMyActionItem("UNKNOWN") === false, "UNKNOWN is excluded");
  ok("V2.14 isMyActionItem", isMyActionItem(undefined) === false, "undefined (no resolvable relation) is excluded");
}


// ===== V2.14 §2 — RelationBadge: one pill per value except UNKNOWN (renders nothing), and
// every rendered value is distinguishable by its own label text, not color alone. =====
{
  const html = (relation: Parameters<typeof RelationBadge>[0]["relation"]) => renderToStaticMarkup(React.createElement(RelationBadge, { relation }));
  const assigned = html("ASSIGNED");
  const both = html("ASSIGNED_AND_MENTIONED");
  const mentionedBadge = html("MENTIONED");
  const following = html("FOLLOWING");
  const unknown = html("UNKNOWN");
  const undef = html(undefined);

  ok("V2.14 RelationBadge", assigned.includes("Assigned to you"), "ASSIGNED renders its label");
  ok("V2.14 RelationBadge", both.includes("Assigned") && both.includes("mentioned"), "ASSIGNED_AND_MENTIONED renders a label naming both");
  ok("V2.14 RelationBadge", mentionedBadge.includes("Mentioned you"), "MENTIONED renders its label");
  ok("V2.14 RelationBadge", following.includes("Following"), "FOLLOWING renders its label");
  ok("V2.14 RelationBadge", unknown === "", "UNKNOWN renders nothing — an absent badge, not a placeholder one");
  ok("V2.14 RelationBadge", undef === "", "an undefined relation (e.g. no single resolvable ticket) also renders nothing");

  const labels = [assigned, both, mentionedBadge, following].map((h) => h.replace(/<[^>]+>/g, ""));
  ok("V2.14 RelationBadge", new Set(labels).size === labels.length, "every non-UNKNOWN relation has a visually distinct label — not color alone, matching this app's other badges");
}


// ===== V2.14 §4 — myActionItemsOnly toggle: default, independent per-page setter, and
// persistence — same pattern as the V2.11 §3B showAdvancedSettings toggle above. =====
{
  commandCenterStore.resetAll();
  const initial = commandCenterStore.getSnapshot().myActionItemsOnly;
  ok("V2.14 myActionItemsOnly toggle", initial.attention === false && initial.myDay === false && initial.priorities === false, "defaults to Everything (off) on every page for a first-time user — never a surprising silent-hide default");

  commandCenterStore.setMyActionItemsOnly("attention", true);
  const afterOneSet = commandCenterStore.getSnapshot().myActionItemsOnly;
  ok("V2.14 myActionItemsOnly toggle", afterOneSet.attention === true && afterOneSet.myDay === false && afterOneSet.priorities === false, "setting one page's toggle is independently settable — it never flips another page's");

  const roundTrip = parseStoredState(JSON.stringify(commandCenterStore.getSnapshot()));
  ok("V2.14 myActionItemsOnly toggle", roundTrip.myActionItemsOnly.attention === true && roundTrip.myActionItemsOnly.priorities === false, "round-trips through JSON serialization/parseStoredState unchanged — persists across a reload");

  const fallback = parseStoredState("not valid json");
  ok("V2.14 myActionItemsOnly toggle", fallback.myActionItemsOnly.attention === false && fallback.myActionItemsOnly.myDay === false && fallback.myActionItemsOnly.priorities === false, "malformed stored state falls back to the safe default (Everything) on every page, never a crash");

  commandCenterStore.resetAll();
}


// ===== V2.14 §1/§3 — PersonalRelation wired end-to-end through computeProactiveIntelligence
// (AttentionItem.relation) and computePersonalFocus (PersonalFocusCandidate.relation),
// genuinely independent of ownershipExplicit/AttentionCategory — no DO_NOW/DO_TODAY placement
// or category order changes as a side effect of this pass. =====
{
  // dueDate: TODAY triggers risk-detection.ts's R1 (deadline) rule — a real auto-detected
  // RISK AttentionItem for each item, so this exercises the actual sourceRef -> WorkItem
  // resolution path (same one ticketKey/ticketUrl already use), not a hand-built fixture.
  const relAssigned = jiraItem({ id: "rel-wi-assigned", key: "REL-1", owner: "Alice", ownerId: "acc-alice", dueDate: TODAY });
  const relMentionedOnly = jiraItem({ id: "rel-wi-mentioned", key: "REL-2", owner: "Bob", ownerId: "acc-bob", dueDate: TODAY });
  const relFollowing = jiraItem({ id: "rel-wi-following", key: "REL-3", owner: "Bob", ownerId: "acc-bob", dueDate: TODAY });
  const relData: CommandCenterData = { ...emptyData(), workItems: [relAssigned, relMentionedOnly, relFollowing] };
  const relDerived = deriveData(relData, null, TODAY);
  const relMentionEvents: MentionEvent[] = [{ issueKey: "REL-2", commentId: "rel-c1", excerpt: "please take a look", mentionedAt: TODAY }];

  const relProactive = computeProactiveIntelligence(relData, relDerived, [], null, {}, "jira", TODAY, undefined, relMentionEvents, "acc-alice", "Alice");
  const attnFor = (key: string) => relProactive.attentionQueue.find((i) => i.ticketKey === key);

  ok("V2.14 AttentionItem.relation", attnFor("REL-1")?.relation === "ASSIGNED", "an AttentionItem whose single related WorkItem.ownerId matches the configured accountId classifies ASSIGNED");
  ok("V2.14 AttentionItem.relation", attnFor("REL-2")?.relation === "MENTIONED", "an AttentionItem on a mentioned-but-not-owned ticket classifies MENTIONED");
  ok("V2.14 AttentionItem.relation", attnFor("REL-3")?.relation === "FOLLOWING", "an AttentionItem neither owned nor mentioned, with identity configured, classifies FOLLOWING (never UNKNOWN)");

  // Omitting identityDisplayName/mentionEvents/identityOwnerId is a no-op — no relation is
  // ever fabricated (matches every other additive/optional trailing parameter in this app).
  const relProactiveNoIdentity = computeProactiveIntelligence(relData, relDerived, [], null, {}, "jira", TODAY);
  ok(
    "V2.14 AttentionItem.relation",
    relProactiveNoIdentity.attentionQueue.every((i) => i.relation === undefined || i.relation === "UNKNOWN"),
    "with no identity configured at all, no AttentionItem is ever assigned a guessed relation"
  );

  const relFocus = computePersonalFocus(relData, relProactive, "Alice", TODAY, "acc-alice", undefined, relDerived.risks, relMentionEvents);
  const candFor = (key: string) => relFocus.candidates.find((c) => c.ticketKey === key);
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-1")?.relation === "ASSIGNED", "the same WorkItem resolves to ASSIGNED as a PersonalFocusCandidate too");
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-2")?.relation === "MENTIONED", "MENTIONED carries through to PersonalFocusCandidate");
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-3")?.relation === "FOLLOWING", "FOLLOWING carries through to PersonalFocusCandidate");

  // Independence from ownershipExplicit/category (§1's explicit non-goal): a WATCH/low-score
  // candidate can still be ASSIGNED, and relation never changes score/category/DO_NOW
  // placement — asserting the untouched fields stayed exactly what they'd be without §1.
  const bareFocus = computePersonalFocus(relData, relProactive, "Alice", TODAY, "acc-alice", undefined, relDerived.risks);
  const bareCand = bareFocus.candidates.find((c) => c.ticketKey === "REL-1");
  const withRelCand = candFor("REL-1");
  ok(
    "V2.14 independence from scoring",
    !!bareCand && !!withRelCand && bareCand.score === withRelCand.score && bareCand.category === withRelCand.category && bareCand.ownershipExplicit === withRelCand.ownershipExplicit,
    "adding PersonalRelation classification (via the mentionEvents parameter) never changes score, category, or ownershipExplicit — a read-only, additive pass"
  );

  // isMyActionItem composes correctly as an extra AND filter over the real candidate set.
  const myActionCandidates = relFocus.candidates.filter((c) => isMyActionItem(c.relation));
  ok(
    "V2.14 isMyActionItem integration",
    myActionCandidates.some((c) => c.ticketKey === "REL-1") && myActionCandidates.some((c) => c.ticketKey === "REL-2") && !myActionCandidates.some((c) => c.ticketKey === "REL-3"),
    "'My action items only' keeps ASSIGNED/MENTIONED candidates and excludes the FOLLOWING one"
  );
}


// ===== V2.15 — Cross-Device Consistency =====

// --- sync-auth.ts: checkSyncRequestAuth (jira/sync POST gate — accepts EITHER secret) ---
// V2.18 §4 — the pre-V2.18 "neither secret configured -> open" default is a confirmed P0
// finding (see the security hardening pass); these assertions now lock in the fail-closed
// replacement, matching checkAppStateAuth's existing (already-correct) 503 contract exactly.
{
  const unconfigured1 = checkSyncRequestAuth(null, undefined, undefined);
  ok("V2.18 sync-auth", unconfigured1.ok === false && unconfigured1.status === 503, "neither secret configured -> unauthorized (503, not available) — the fail-open default is gone");
  const unconfigured2 = checkSyncRequestAuth("Bearer anything", undefined, undefined);
  ok("V2.18 sync-auth", unconfigured2.ok === false && unconfigured2.status === 503, "still closed with neither configured, regardless of what header (if any) is sent");

  const noHeader = checkSyncRequestAuth(null, "cron-secret", undefined);
  ok("V2.18 sync-auth", noHeader.ok === false && noHeader.status === 401, "only CRON_SECRET configured, no header -> unauthorized");
  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer cron-secret", "cron-secret", undefined).ok === true, "only CRON_SECRET configured, matching header -> authorized (the automated cron/GitHub Action path)");
  const wrongHeader = checkSyncRequestAuth("Bearer wrong", "cron-secret", undefined);
  ok("V2.18 sync-auth", wrongHeader.ok === false && wrongHeader.status === 401, "only CRON_SECRET configured, wrong header -> unauthorized");

  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer app-state-secret", undefined, "app-state-secret").ok === true, "only APP_STATE_SECRET configured, matching header -> authorized (a paired browser with no CRON_SECRET set)");

  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer cron-secret", "cron-secret", "app-state-secret").ok === true, "both configured: a request bearing CRON_SECRET is authorized");
  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer app-state-secret", "cron-secret", "app-state-secret").ok === true, "both configured: a request bearing APP_STATE_SECRET is ALSO authorized — both work at the same time");
  const neitherValid = checkSyncRequestAuth("Bearer neither-of-these", "cron-secret", "app-state-secret");
  ok("V2.18 sync-auth", neitherValid.ok === false && neitherValid.status === 401, "both configured: a request bearing neither valid secret is rejected");
  const noHeaderBothConfigured = checkSyncRequestAuth(null, "cron-secret", "app-state-secret");
  ok("V2.18 sync-auth", noHeaderBothConfigured.ok === false && noHeaderBothConfigured.status === 401, "both configured: no header at all is rejected");

  // V2.20 — a trailing newline/space in the configured env var (a real-world gotcha: pasting
  // `openssl rand -hex 32` terminal output straight into a deployment's env var UI often
  // carries one) must never make an otherwise-correct paired secret 401 forever.
  const trimmedCronSecret = checkSyncRequestAuth("Bearer cron-secret", "cron-secret\n", undefined);
  ok("V2.20 sync-auth secret trimming", trimmedCronSecret.ok === true, "CRON_SECRET env var with a trailing newline still authorizes a header sent without one");
  const trimmedAppStateSecret = checkSyncRequestAuth("Bearer app-state-secret", undefined, "  app-state-secret  ");
  ok("V2.20 sync-auth secret trimming", trimmedAppStateSecret.ok === true, "APP_STATE_SECRET env var with surrounding whitespace still authorizes a header sent without it");
  const whitespaceOnlyBothUnconfigured = checkSyncRequestAuth(null, "  ", "\n");
  ok("V2.20 sync-auth secret trimming", whitespaceOnlyBothUnconfigured.ok === false && whitespaceOnlyBothUnconfigured.status === 503, "whitespace-only env vars are treated as unset, not as configured-but-unmatchable secrets");
}


// ===== V2.18 — Security hardening: consistent auth across every sensitive route =====
// Confirmed P0 finding: jira/projects, jira/conformance, ai (POST), and notify (POST) had NO
// auth code path at all, regardless of any env var — unlike jira/sync and state, which at
// least checked something. These assertions confirm each route now gates on the same shared
// checkSyncRequestAuth, and that every client caller that talks to a now-gated route attaches
// the paired-device secret (source-regex checks: these routes/callers transitively import
// "server-only" or are client components, so they're read rather than imported/executed,
// matching this suite's existing precedent for route-level and client-fetch wiring checks).
{
  const repoRoot = path.resolve(process.cwd());
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

  const gatedRoutes = [
    "src/app/api/command-center/jira/projects/route.ts",
    "src/app/api/command-center/jira/conformance/route.ts",
    "src/app/api/command-center/ai/route.ts",
    "src/app/api/command-center/notify/route.ts",
  ];
  for (const routePath of gatedRoutes) {
    const src = read(routePath);
    ok("V2.18 Security route wiring", /import \{ checkSyncRequestAuth \} from "@\/lib\/command-center\/jira\/sync-auth"/.test(src), `${routePath} imports the shared auth check rather than a private/duplicated one`);
    ok("V2.18 Security route wiring", /checkSyncRequestAuth\(/.test(src), `${routePath} actually calls the auth check`);
  }

  const gatedClientCallers = [
    "src/lib/command-center/notify-client.ts",
    "src/components/command-center/use-command-center.ts",
    "src/lib/command-center/ai/claude-provider.ts",
    "src/lib/command-center/datasource/jira-source.ts",
    "src/app/data-settings/page.tsx",
  ];
  for (const callerPath of gatedClientCallers) {
    const src = read(callerPath);
    ok("V2.18 Security client wiring", /pairedAuthHeader/.test(src), `${callerPath} imports/uses pairedAuthHeader so its request(s) to a now-gated route can authenticate as a paired device`);
  }
}


// --- app-state.ts: checkAppStateAuth (state route's own auth — deliberately NOT open when
// unconfigured, unlike sync-auth.ts above) ---
{
  const unconfigured = checkAppStateAuth(null, undefined);
  ok("V2.15 checkAppStateAuth", unconfigured.ok === false && !unconfigured.ok && unconfigured.status === 503, "APP_STATE_SECRET unset -> 503 (sync treated as unavailable), never silently open — this synced slice is genuinely private, unlike jira/sync's re-derivable-from-Jira data");

  const missingHeader = checkAppStateAuth(null, "state-secret");
  ok("V2.15 checkAppStateAuth", missingHeader.ok === false && !missingHeader.ok && missingHeader.status === 401, "APP_STATE_SECRET configured, no Authorization header -> 401");

  const wrongHeader = checkAppStateAuth("Bearer wrong-value", "state-secret");
  ok("V2.15 checkAppStateAuth", wrongHeader.ok === false && !wrongHeader.ok && wrongHeader.status === 401, "APP_STATE_SECRET configured, mismatched header -> 401");

  const correctHeader = checkAppStateAuth("Bearer state-secret", "state-secret");
  ok("V2.15 checkAppStateAuth", correctHeader.ok === true, "APP_STATE_SECRET configured, matching header -> authorized");

  // V2.20 — same trimming fix, and for the same real-world "copy-pasted a trailing newline
  // into the deployment's env var UI" reason, as checkSyncRequestAuth above.
  const trimmedSecret = checkAppStateAuth("Bearer state-secret", "state-secret\n");
  ok("V2.20 checkAppStateAuth secret trimming", trimmedSecret.ok === true, "APP_STATE_SECRET env var with a trailing newline still authorizes a header sent without one");
  const whitespaceOnlyUnconfigured = checkAppStateAuth(null, "   ");
  ok("V2.20 checkAppStateAuth secret trimming", whitespaceOnlyUnconfigured.ok === false && whitespaceOnlyUnconfigured.status === 503, "a whitespace-only env var is treated as unset (503), not as configured-but-unmatchable");
}


// --- app-state.ts: isAppStateStoreConfigured (KV env-var presence check, same pattern as
// V2.13's isNotifyStoreConfigured) ---
{
  const originalKvUrl = process.env.KV_REST_API_URL;
  const originalKvToken = process.env.KV_REST_API_TOKEN;

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === false, "false with no KV env vars set");

  process.env.KV_REST_API_URL = "https://kv.example.test";
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === false, "URL alone is not enough — both are required");

  process.env.KV_REST_API_TOKEN = "kv-tok";
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === true, "true once both KV env vars are set");

  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalKvToken;
}


// --- app-state.ts: createInMemoryAppStateStore (the offline-test fake) ---
{
  const store = createInMemoryAppStateStore(null);
  ok("V2.15 in-memory app state store", (await store.get()) === null, "starts with no baseline when constructed with null");
  const seeded: SyncedAppState = {
    jiraWorkRelevancePolicy: {},
    attentionState: {},
    decisions: [],
    actionPlanState: { actions: [], personalPlan: [] },
    memoryEvents: [],
    dailyReports: {},
    uiPreferences: { showAdvancedSettings: false, myActionItemsOnly: { attention: false, myDay: false, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  await store.set(seeded);
  const roundTripped = await store.get();
  ok("V2.15 in-memory app state store", roundTripped?.updatedAtIso === "2026-01-01T00:00:00.000Z", "set() then get() round-trips the exact value written");
}


// --- app-state.ts: syncedAppStateSchema (POST body top-level structural validation) ---
{
  const validBody = {
    personalIdentity: { id: "id1", displayName: "Alice" },
    jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
    attentionState: { "risk:1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" } },
    decisions: [{ id: "d1", projectId: "p1", title: "T", status: "made", description: "d" }],
    actionPlanState: { actions: [], personalPlan: [] },
    memoryEvents: [],
    dailyReports: {},
    uiPreferences: { showAdvancedSettings: true, myActionItemsOnly: { attention: false, myDay: true, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  ok("V2.15 syncedAppStateSchema", syncedAppStateSchema.safeParse(validBody).success === true, "a well-formed synced-state blob parses");
  ok("V2.15 syncedAppStateSchema", syncedAppStateSchema.safeParse({}).success === false, "an empty body is rejected — every top-level field is required");
  ok(
    "V2.15 syncedAppStateSchema",
    syncedAppStateSchema.safeParse({ ...validBody, jiraProjectScope: undefined, uiPreferences: { ...validBody.uiPreferences, jiraProjectScope: { mode: "SOMETHING_ELSE", projectKeys: [] } } }).success === false,
    "an invalid jiraProjectScope.mode value is rejected — not just any string"
  );
  ok(
    "V2.15 syncedAppStateSchema",
    syncedAppStateSchema.safeParse({ ...validBody, decisions: "not-an-array" }).success === false,
    "a wrong-shaped field (decisions as a string) is rejected rather than silently coerced"
  );
}


// --- app-state-sync.ts: pure decision/merge logic (no fetch/timer involved — directly
// testable, matching jira/http.ts's own fetchXWith dependency-injection discipline) ---
{
  function makeSyncedState(overrides: Partial<SyncedAppState> = {}): SyncedAppState {
    return {
      personalIdentity: undefined,
      jiraWorkRelevancePolicy: {},
      attentionState: {},
      decisions: [],
      actionPlanState: { actions: [], personalPlan: [] },
      memoryEvents: [],
      dailyReports: {},
      uiPreferences: { showAdvancedSettings: false, myActionItemsOnly: { attention: false, myDay: false, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
      updatedAtIso: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }
  function baseStoreState(patch: Partial<StoreState> = {}): StoreState {
    return { ...parseStoredState("{}"), ...patch };
  }
  function makeDecision(id: string, extra: Partial<Decision> = {}): Decision {
    return { id, projectId: "p1", title: `Decision ${id}`, status: "made", description: "d", ...extra };
  }
  function makeAction(id: string): Action {
    return { id, title: `Action ${id}`, why: "why", status: "open", estimateMinutes: 15, createdAt: "2026-01-01" };
  }
  function makePlanItem(id: string): PersonalPlanItem {
    return { id, sourceType: "attention", sourceId: `src-${id}`, priority: 0, position: 0, plannedDate: "2026-01-01", status: "planned", estimatedMinutes: 15, addedAt: "2026-01-01T00:00:00.000Z" };
  }

  // extractSyncedAppState — pulls exactly the synced fields, untouched.
  {
    const state = baseStoreState({
      personalIdentity: { id: "id1", displayName: "Alice" },
      jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
      attentionState: { "risk:1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-02" } },
      data: { ...emptyData(), decisions: [makeDecision("d1")], actions: [makeAction("a1")] },
      personalPlan: [makePlanItem("p1")],
      memoryEvents: [{ id: "m1", date: "2026-01-01", kind: "DECISION_MADE", title: "t", impact: "i", evidence: [] }],
      dailyReports: { "2026-01-01": { date: "2026-01-01", generatedAt: "2026-01-01T20:00:00.000Z", events: [] } },
      showAdvancedSettings: true,
      myActionItemsOnly: { attention: true, myDay: false, priorities: true },
      jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] },
    });
    const extracted = extractSyncedAppState(state, "2026-02-01T00:00:00.000Z");
    ok("V2.15 extractSyncedAppState", extracted.personalIdentity?.id === "id1", "personalIdentity carried through");
    ok("V2.15 extractSyncedAppState", extracted.decisions.length === 1 && extracted.decisions[0].id === "d1", "decisions pulled from data.decisions");
    ok(
      "V2.15 extractSyncedAppState",
      extracted.actionPlanState.actions.length === 1 && extracted.actionPlanState.actions[0].id === "a1" && extracted.actionPlanState.personalPlan.length === 1 && extracted.actionPlanState.personalPlan[0].id === "p1",
      "actionPlanState bundles data.actions (Action Plan page) and personalPlan (Focus Session/Close Day) together"
    );
    ok("V2.15 extractSyncedAppState", extracted.memoryEvents.length === 1 && extracted.memoryEvents[0].id === "m1", "memoryEvents carried through");
    ok("V2.17 extractSyncedAppState", Object.keys(extracted.dailyReports).length === 1 && extracted.dailyReports["2026-01-01"].date === "2026-01-01", "dailyReports carried through (Task 2 point 5 — added to the synced slice)");
    ok(
      "V2.15 extractSyncedAppState",
      extracted.uiPreferences.showAdvancedSettings === true && extracted.uiPreferences.myActionItemsOnly.attention === true && extracted.uiPreferences.jiraProjectScope.mode === "FOCUSED",
      "uiPreferences bundles the three V2.11-V2.14 preference fields together"
    );
    ok("V2.15 extractSyncedAppState", extracted.updatedAtIso === "2026-02-01T00:00:00.000Z", "updatedAtIso is exactly what the caller supplied — this function never invents a timestamp");
  }

  // looksUnused — the case-B heuristic.
  {
    ok("V2.15 looksUnused", looksUnused(baseStoreState()) === true, "a pristine, never-touched local install looks unused");
    ok("V2.15 looksUnused", looksUnused(baseStoreState({ data: { ...emptyData(), decisions: [makeDecision("d1")] } })) === false, "a single logged decision disqualifies the 'unused' heuristic");
    ok(
      "V2.15 looksUnused",
      looksUnused(baseStoreState({ attentionState: { x: { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" } } })) === false,
      "a real attention-lifecycle transition disqualifies 'unused'"
    );
    ok("V2.15 looksUnused", looksUnused(baseStoreState({ personalPlan: [makePlanItem("p1")] })) === false, "real Action Plan/Close Day planning activity disqualifies 'unused'");
  }

  // mergeSyncedAppState — record collections union by id (never drops a not-yet-synced local
  // record); Records (attentionState/policy map) union with server winning per shared key;
  // scalar preference blocks take the server's whole value (single-blob-timestamp honesty
  // limit — see the function's own comment).
  {
    const local = makeSyncedState({
      personalIdentity: { id: "local-id", displayName: "Local Name" },
      jiraWorkRelevancePolicy: { "Local Status": "OBSERVE", "Shared Status": "WAITING" },
      attentionState: {
        "local-only": { lifecycle: "NEW", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" },
        shared: { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" },
      },
      decisions: [makeDecision("local-only-d"), makeDecision("shared-d")],
      actionPlanState: { actions: [makeAction("local-only-a")], personalPlan: [makePlanItem("local-only-p")] },
      memoryEvents: [{ id: "local-only-m", date: "2026-01-01", kind: "DECISION_MADE", title: "local", impact: "i", evidence: [] }],
      dailyReports: {
        "local-only-day": { date: "local-only-day", generatedAt: "2026-01-01T20:00:00.000Z", events: [] },
        "shared-day": { date: "shared-day", generatedAt: "2026-01-01T20:00:00.000Z", events: [] },
      },
      updatedAtIso: "2026-01-01T00:00:00.000Z",
    });
    const server = makeSyncedState({
      personalIdentity: { id: "server-id", displayName: "Server Name" },
      jiraWorkRelevancePolicy: { "Server Status": "COMPLETED", "Shared Status": "ACTIONABLE" },
      attentionState: {
        "server-only": { lifecycle: "NEW", firstSeenDate: "2026-02-01", lastSeenDate: "2026-02-01" },
        shared: { lifecycle: "RESOLVED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-02-01" },
      },
      decisions: [makeDecision("server-only-d"), makeDecision("shared-d", { title: "Updated on server" })],
      actionPlanState: { actions: [makeAction("server-only-a")], personalPlan: [makePlanItem("server-only-p")] },
      memoryEvents: [{ id: "server-only-m", date: "2026-02-01", kind: "DECISION_MADE", title: "server", impact: "i", evidence: [] }],
      dailyReports: {
        "server-only-day": { date: "server-only-day", generatedAt: "2026-02-01T20:00:00.000Z", events: [] },
        "shared-day": { date: "shared-day", generatedAt: "2026-02-01T20:00:00.000Z", events: [{ id: "server-e", date: "shared-day", kind: "DECISION_MADE", title: "server version", impact: "i", evidence: [] }] },
      },
      uiPreferences: { showAdvancedSettings: true, myActionItemsOnly: { attention: true, myDay: true, priorities: true }, jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] } },
      updatedAtIso: "2026-02-01T00:00:00.000Z",
    });

    const merged = mergeSyncedAppState(local, server);

    ok("V2.15 mergeSyncedAppState", merged.personalIdentity?.id === "server-id", "identity: server's whole value wins (single-blob timestamp — see function comment)");
    ok(
      "V2.15 mergeSyncedAppState",
      merged.jiraWorkRelevancePolicy["Local Status"] === "OBSERVE" && merged.jiraWorkRelevancePolicy["Server Status"] === "COMPLETED" && merged.jiraWorkRelevancePolicy["Shared Status"] === "ACTIONABLE",
      "policy map: local-only and server-only keys both survive; a key present on both sides takes the server's value"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      "local-only" in merged.attentionState && "server-only" in merged.attentionState && merged.attentionState["shared"].lifecycle === "RESOLVED",
      "attentionState: same union-with-server-winning-on-conflict rule as the policy map"
    );
    const decisionIds = merged.decisions
      .map((d) => d.id)
      .sort()
      .join(",");
    ok("V2.15 mergeSyncedAppState", decisionIds === "local-only-d,server-only-d,shared-d", "decisions: id-union — a locally-added-but-not-yet-synced decision is never dropped just because the server's overall blob is newer");
    ok("V2.15 mergeSyncedAppState", merged.decisions.find((d) => d.id === "shared-d")?.title === "Updated on server", "decisions: a shared id takes the server's (newer) version, never the stale local one");
    ok(
      "V2.15 mergeSyncedAppState",
      merged.actionPlanState.actions
        .map((a) => a.id)
        .sort()
        .join(",") === "local-only-a,server-only-a",
      "actionPlanState.actions: same id-union rule"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.actionPlanState.personalPlan
        .map((p) => p.id)
        .sort()
        .join(",") === "local-only-p,server-only-p",
      "actionPlanState.personalPlan: same id-union rule"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.memoryEvents
        .map((m) => m.id)
        .sort()
        .join(",") === "local-only-m,server-only-m",
      "memoryEvents: same id-union rule"
    );
    ok(
      "V2.17 mergeSyncedAppState",
      "local-only-day" in merged.dailyReports && "server-only-day" in merged.dailyReports && merged.dailyReports["shared-day"].events[0]?.id === "server-e",
      "dailyReports: same union-with-server-winning-on-conflict rule as attentionState/policy map (Task 2 point 5)"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.uiPreferences.showAdvancedSettings === true && merged.uiPreferences.jiraProjectScope.mode === "FOCUSED",
      "uiPreferences: server's whole preference block wins — a genuinely single toggle blob with no finer-grained freshness signal available"
    );
    ok("V2.15 mergeSyncedAppState", merged.updatedAtIso === server.updatedAtIso, "the merge result carries the server's updatedAtIso forward");
  }

  // decideInitialSync — the full on-load decision tree (Task 3 §2's three cases + Task 4's
  // migration-safety scenario, all pure and directly testable).
  {
    const localRich = baseStoreState({ data: { ...emptyData(), decisions: [makeDecision("local-d")] } });
    const localFresh = baseStoreState();
    const localRichSlice = extractSyncedAppState(localRich, "2026-01-01T00:00:00.000Z");
    const localFreshSlice = extractSyncedAppState(localFresh, "2026-01-01T00:00:00.000Z");

    // Task 4 — an install with real pre-existing local data (attentionState/decisions from a
    // pre-V2.15 version) must become the server baseline the first time V2.15 ships and this
    // device loads before any server state exists — never be silently discarded or ignored.
    const d1 = decideInitialSync(localRichSlice, localRich, null, undefined);
    ok(
      "V2.15 decideInitialSync (Task 4 migration safety)",
      d1.kind === "push-as-baseline",
      "server has no state yet -> local (including its real, pre-existing decisions) becomes the baseline — the exact scenario Task 4 requires a dedicated test for"
    );

    const serverState = makeSyncedState({ decisions: [makeDecision("server-d")], updatedAtIso: "2026-03-01T00:00:00.000Z" });

    const d2 = decideInitialSync(localFreshSlice, localFresh, serverState, undefined);
    ok("V2.15 decideInitialSync", d2.kind === "adopt-server", "a never-meaningfully-used local install adopts the server's real copy wholesale (case B)");

    const d3 = decideInitialSync(localRichSlice, localRich, serverState, "2026-01-01T00:00:00.000Z");
    ok(
      "V2.15 decideInitialSync",
      d3.kind === "merge" && d3.merged.decisions.some((dc) => dc.id === "local-d") && d3.merged.decisions.some((dc) => dc.id === "server-d"),
      "both sides have real content and the server is newer than this device's last known sync point -> a field-level merge (case C), never a blind overwrite that would drop the local-only decision"
    );

    const d4 = decideInitialSync(localRichSlice, localRich, serverState, "2026-05-01T00:00:00.000Z");
    ok(
      "V2.15 decideInitialSync",
      d4.kind === "push-local-forward",
      "this device's last known sync point is already at least as new as the server's current blob -> local is pushed forward rather than pulling something not actually newer (the fourth, implicit case)"
    );
  }
}


// --- state/route.ts wiring (static source checks — the route transitively imports
// "server-only" via app-state-store.ts, so it can never be imported into this offline test
// process; same reasoning as jira/sync/route.ts's own V2.13/V2.15 wiring checks above) ---
{
  const repoRoot = path.resolve(process.cwd());
  const stateRouteSrc = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/state/route.ts"), "utf8");
  ok("V2.15 state route wiring", /checkAppStateAuth/.test(stateRouteSrc), "the route delegates auth to the shared, directly-tested checkAppStateAuth, never a second inline implementation");
  ok("V2.15 state route wiring", /createAppStateStore/.test(stateRouteSrc), "the route wires the real KV-backed store, not the in-memory test fake");
  ok("V2.15 state route wiring", /isAppStateStoreConfigured/.test(stateRouteSrc), "the route also checks KV configuration, not just the secret");
  ok("V2.15 state route wiring", /syncedAppStateSchema/.test(stateRouteSrc), "POST validates the request body's top-level shape via the shared schema before writing it to KV");
  ok("V2.15 state route wiring", /export async function GET/.test(stateRouteSrc) && /export async function POST/.test(stateRouteSrc), "both GET and POST are exported and (per the auth check above) both require the same Authorization header");
}


// --- Secret hygiene (Definition of Done: APP_STATE_SECRET must never reach the client bundle
// via a NEXT_PUBLIC_* env var, and device-pairing.ts — the one client module that touches this
// secret — must never read it from process.env; the real "grep the built .next output"
// verification per the dev prompt's own instruction is a separate, manual `npm run build` step,
// not part of this offline suite, matching this app's own V2.10 Slack-webhook precedent) ---
{
  const repoRoot = path.resolve(process.cwd());
  function walkTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkTsFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const srcFiles = walkTsFiles(path.join(repoRoot, "src"));
  const leaked = srcFiles.filter((f) => /NEXT_PUBLIC[_A-Z]*APP_STATE_SECRET|APP_STATE_SECRET[_A-Z]*NEXT_PUBLIC/.test(fs.readFileSync(f, "utf8")));
  ok("V2.15 secret hygiene", leaked.length === 0, "APP_STATE_SECRET is never wired through a NEXT_PUBLIC_* env var anywhere in source — the only client-side path is device-pairing.ts's localStorage pairing screen");

  const pairingSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/device-pairing.ts"), "utf8");
  ok("V2.15 secret hygiene", !/process\.env/.test(pairingSrc), "device-pairing.ts never reads any server env var directly — the paired secret only ever comes from this device's own localStorage, pasted once via the Data & Settings pairing screen");
}


// --- V2.16 — real production incident: HSWB-1298 (assigned overnight) and WF-1083
// (mentioned overnight) appeared on NEITHER My Day, Priorities, NOR the Attention Queue, with
// zero error shown anywhere a user would normally look. Traced end-to-end: both tickets'
// Work Relevance statuses ("In Progress" -> ACTIONABLE, "Awaiting Review" -> WAITING) were
// already classified — not the V2.11-era "unclassified status" failure mode this app already
// guards against. The real cause was upstream, at Sync ingestion: this deployment has
// CRON_SECRET configured with no APP_STATE_SECRET to pair a browser against (see
// sync-auth.ts/device-pairing.ts), so every client-initiated sync (manual "Sync Now" and any
// auto-sync-on-load) had been failing with a "cron-unauthorized" 401 for a full week straight
// — jiraSync.lastSyncCompletedAt was stuck on 2026-09-02 while lastSyncStartedAt showed a
// same-morning retry, so nothing updated after that date ever reached local state, regardless
// of Work Relevance/ownership/mention classification downstream. Nothing surfaced this as a
// *standing* failure: the header's own "Sync failed" text is a few unobtrusive words, and
// page.tsx's "Before You Trust This Data" panel actually stopped rendering entirely on a
// failed sync (gated on lastSyncStatus === "success") instead of escalating — the opposite of
// what a data-trust surface should do when trust is exactly what's in question.
//
// Fix: a prominent, impossible-to-miss banner (Header.tsx's SyncFailedBanner) that renders on
// EVERY page (Header lives in the root layout, not one screen) for as long as
// jiraSync.lastSyncStatus === "failed" — driven purely by that status field, so it fires for
// ANY sync failure kind (auth, network, rate-limit, malformed response), not just this one
// pairing gap. This generalizes the fix beyond the two specific tickets: the next time a sync
// silently starts failing, for whatever reason, the app now says so loudly on every screen
// instead of quietly serving stale data with nothing to indicate it's stopped updating. ---
{
  const repoRoot = path.resolve(process.cwd());

  // Pure arithmetic behind the banner's staleness sentence — directly testable even though
  // the component that calls it can't be rendered in this no-DOM/SSR-only test environment.
  ok("V2.16 daysStale", daysStale(undefined) === undefined, "no lastSyncCompletedAt at all (never synced) reports undefined, not a fabricated 0/NaN day count");
  const nowMs = new Date("2026-09-09T12:00:00.000Z").getTime();
  ok("V2.16 daysStale", daysStale("2026-09-02T13:57:19.035Z", nowMs) === 6, "a sync completed 6 days and change before 'now' reports 6 full days stale — the exact real-incident shape (lastSyncCompletedAt stuck on 2026-09-02 while HSWB-1298/WF-1083 were updated on 2026-09-08)");
  ok("V2.16 daysStale", daysStale("2026-09-09T06:00:00.000Z", nowMs) === 0, "a sync completed earlier the same day reports 0 days stale, not 1 (no off-by-one from truncation)");
  ok("V2.16 daysStale", daysStale("2026-09-10T00:00:00.000Z", nowMs) === undefined, "a timestamp in the future (clock skew) reports undefined rather than a nonsensical negative day count");

  // The banner itself can't be rendered here (useCommandCenter's useSyncExternalStore takes
  // the fixed getServerSnapshot branch outside a real browser — see daysStale's own export
  // comment above) — so its wiring is verified the same way this suite already verifies other
  // route/UI wiring facts it can't execute directly (e.g. the V2.15 state-route/secret-hygiene
  // checks above): reading the real source and asserting the specific lines that make the fix
  // real are actually present, not just a same-shaped decoy.
  const headerSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/Header.tsx"), "utf8");
  ok("V2.16 Header wiring", /function SyncFailedBanner/.test(headerSrc), "Header.tsx defines the sync-failed banner");
  ok("V2.16 Header wiring", /state\.jiraSync\.lastSyncStatus !== "failed"\) return null/.test(headerSrc), "the banner's only gate is lastSyncStatus === 'failed' — no dependency on WHY it failed, so it fires for every failure kind, not just cron-unauthorized");
  ok("V2.16 Header wiring", /<SyncFailedBanner \/>/.test(headerSrc) && /export function Header/.test(headerSrc), "the banner is rendered unconditionally inside the exported Header component");
  ok("V2.16 Header wiring", /JIRA_ERROR_HELP\[state\.jiraSync\.lastSyncErrorKind\]/.test(headerSrc), "the banner explains the failure using the same JIRA_ERROR_HELP text Data & Settings shows, not a second/divergent explanation");

  const layoutSrc = fs.readFileSync(path.join(repoRoot, "src/app/layout.tsx"), "utf8");
  ok("V2.16 Header wiring", /<Header \/>/.test(layoutSrc), "Header (and therefore the banner) is mounted once in the root layout, so it appears on My Day, Priorities, and Attention Queue alike — not copy-pasted per page, which would risk one page being missed");

  // JIRA_ERROR_HELP itself must be the single shared source Data & Settings already had —
  // moved, not duplicated, so the two surfaces can never drift into disagreeing explanations.
  const errorHelpSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/jira/error-help.ts"), "utf8");
  ok("V2.16 error-help wiring", /cron-unauthorized/.test(errorHelpSrc) && /export const JIRA_ERROR_HELP/.test(errorHelpSrc), "the shared JIRA_ERROR_HELP module carries the real explanations, including cron-unauthorized (the actual cause of this incident)");
  const dataSettingsSrc2 = fs.readFileSync(path.join(repoRoot, "src/app/data-settings/page.tsx"), "utf8");
  ok("V2.16 error-help wiring", /from "@\/lib\/command-center\/jira\/error-help"/.test(dataSettingsSrc2), "Data & Settings imports JIRA_ERROR_HELP from the shared module");
  ok("V2.16 error-help wiring", !/const JIRA_ERROR_HELP/.test(dataSettingsSrc2), "Data & Settings no longer carries its own duplicate copy of the map");

  // The trust panel disappearing entirely on a failed sync (documented above as part of why
  // this went unnoticed) is a real, separate finding — noted here as a currently-accepted
  // pre-existing behavior (not silently reversed by this pass) so a future change to that
  // gate is a deliberate decision, not an accidental side effect of this fix.
  const pageSrc = fs.readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf8");
  ok("V2.16 known pre-existing behavior", /jiraSync\.lastSyncStatus === "success" &&/.test(pageSrc), "documents that 'Before You Trust This Data' still only renders on a successful sync today — the new Header banner is what now covers the failed-sync case on every page instead");
}


// --- V2.16 (part 2) — a second, independent finding surfaced while verifying the sync-auth
// fix above on a real device: even after pairing fixed the auth failure, a real sync's result
// never survived a reload. The actual dataset (thousands of work items plus history) produced
// a ~7.8MB JSON blob; localStorage's per-origin quota (~5-8MB in the browser this was found
// in) rejected the write with QuotaExceededError, and the old persist() swallowed it in a bare
// try/catch — the UI showed "Connected" (the in-memory state update always succeeds), but
// nothing was ever written to disk, so the next reload silently reverted to whatever last fit.
//
// Fix: local persistence moved to IndexedDB (src/lib/command-center/local-db.ts), whose quota
// is a large fraction of available disk space rather than a fixed ~5-10MB ceiling. Real
// IndexedDB read/write round-trips can't be exercised in this Node-based offline suite (no
// `indexedDB` global, and this app deliberately doesn't shim one — see local-db.ts's own
// comment), so — matching this suite's existing precedent for other browser-only wiring it
// can't execute directly (e.g. the V2.15 secret-hygiene checks above) — this verifies the
// actual source: that store.ts only ever takes the new IndexedDB path when `indexedDB` exists,
// and falls back to the EXACT original synchronous localStorage code otherwise (old browsers,
// some private-browsing modes, and — provably, since every test above this point just passed
// unmodified — this suite's own Node environment, which has no indexedDB global at all). ---
{
  const repoRoot = path.resolve(process.cwd());
  const localDbSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/local-db.ts"), "utf8");
  ok("V2.16 IndexedDB backend", /indexedDB\.open\(/.test(localDbSrc), "local-db.ts opens a real IndexedDB database — not a second in-memory/localStorage implementation wearing an IndexedDB name");
  ok("V2.16 IndexedDB backend", /export async function idbGet/.test(localDbSrc) && /export async function idbSet/.test(localDbSrc), "exposes a minimal get/set pair, matching the single-blob shape store.ts already persists");

  const storeSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/store.ts"), "utf8");
  // A2 — writes now go through idbUpdate (one atomic readwrite transaction) instead of a blind idbSet.
  ok("V2.16 IndexedDB wiring", /import \{ idbGet, idbUpdate \} from "\.\/local-db"/.test(storeSrc), "store.ts uses the shared IndexedDB adapter, not a duplicated implementation");
  ok(
    "V2.16 IndexedDB wiring",
    (storeSrc.match(/typeof indexedDB === "undefined"/g) ?? []).length === 1 && /private storage\(\): StateStorage \| null/.test(storeSrc),
    "A2: hydrate() and persist() share ONE storage() resolver that checks IndexedDB availability exactly once, so the fallback path is a deliberate branch, not an accidental gap"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /createLocalStorageStateStorage\(\(\) => window\.localStorage, STORAGE_KEY\)/.test(storeSrc),
    "persist()'s fallback-when-no-IndexedDB branch still writes window.localStorage under the same key (now rev-checked) — so every existing (Node-based, indexedDB-less) test above continues to exercise the real fallback code path"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /idbUpdate\(STORAGE_KEY, \(current\) => \(current \? null : serializeWithRev\(migrated, 0\)\)\)/.test(storeSrc) && /window\.localStorage\.removeItem\(STORAGE_KEY\)/.test(storeSrc),
    "the legacy-localStorage migration writes the existing data into IndexedDB and only then clears the old key — a device that already has real local data (every install from before this pass) is migrated, never silently reset to pristine"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /catch \{\s*\/\/ Migration write failed/.test(storeSrc),
    "a failed migration write leaves the legacy localStorage copy in place (not cleared) — a genuinely lost write here would look exactly like the original bug, so the migration itself must be safe on partial failure"
  );
}


// --- V2.17 — a third, independent finding, surfaced when asked to check why mentionEvents
// was coming back empty even after the V2.16 fixes: HSWB-1298/WF-1083's original mention on
// WF-1083 STILL wouldn't have been found by the JQL search alone, because Jira's own comment
// full-text search index has a real indexing lag — confirmed directly against the real
// instance (see selectRecentMentionCandidates's own comment for the exact evidence). The pure
// selection logic itself is fully unit-tested above; this verifies the sync route actually
// wires it in, rather than leaving the fix stranded as dead code only the test file exercises. ---
{
  const repoRoot = path.resolve(process.cwd());
  const syncRouteSrc2 = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok("V2.17 Sync route wiring", /import \{ buildMentionEvents, (latestOwnCommentAt, )?selectRecentMentionCandidates \}/.test(syncRouteSrc2), "the route imports the shared, directly-tested selectRecentMentionCandidates rather than a second inline implementation");
  ok("V2.17 Sync route wiring", /selectRecentMentionCandidates\(issuesResult\.data, checkedKeys, Date\.now\(\)\)/.test(syncRouteSrc2), "the recency fallback runs over this sync's own already-fetched issue batch (never a second Jira fetch) and excludes issues the JQL search already covered");
  ok("V2.17 Sync route wiring", (syncRouteSrc2.match(/buildMentionEvents\(issue\.key, commentsResult\.data, accountId/g) ?? []).length === 2, "both the JQL-search pass and the recency-fallback pass call the exact same buildMentionEvents/commentMentionsAccount verification — no second, divergent detection rule for the fallback path");
}
