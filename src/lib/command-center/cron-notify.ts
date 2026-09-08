// V2.13 §2 — the server-side caller that feeds assignment-detection.ts's detectNewAssignments
// and jira/mentions.ts's buildMentionEvents/commentMentionsAccount a PERSISTED "previous"
// state (via a NotifyStateStore) instead of the client's in-browser localStorage/DailySnapshot
// history. Neither detection function is reimplemented here — both were already pure/
// deterministic (built in V2.10 exactly for this kind of diffing); this module only supplies
// the fetch + persisted-baseline plumbing around them.
//
// Deliberately NOT under src/lib/server/ and NOT `import "server-only"`, despite touching
// "Jira credentials" conceptually: every credential/env-var access is pushed to the CALLER
// (src/app/api/command-center/jira/sync/route.ts, itself inherently server-only as an API
// route) — this module takes an already-resolved JiraConnectionConfig, an injected FetchLike,
// and an injected NotifyStateStore, exactly like jira/http.ts's own fetch*With functions.
// That's what lets the offline test suite import and exercise the real cold-start/double-
// notification/connectivity-failure logic directly with fake fixtures, matching this app's
// existing dependency-injection discipline rather than a mocked module boundary (see the dev
// prompt this pass implements — Task 1 point 4 — "the test suite must stay fully offline").

import type { CommandCenterData, DailySnapshot, MentionEvent, WorkItem } from "./types";
import { emptyData } from "./types";
import { detectNewAssignments } from "./assignment-detection";
import { buildMentionEvents, commentMentionsAccount } from "./jira/mentions";
import { normalizeIssues } from "./jira/normalize";
import { fetchAssignedIssuesWith, fetchIssueCommentsWith, fetchMentionedIssuesWith, type FetchLike } from "./jira/http";
import type { JiraConnectionConfig } from "./jira/types";
import { postToSlack, renderSlackText, type SlackFetchLike, type SlackSignal } from "../server/slack-notify";
import type { NotifyStateStore, PersonalNotifyState } from "./notify-state";

export interface ServerNotifyCheckResult {
  notified: number;
  skippedColdStart: boolean;
  // V2.13 §2 Task 2 point 3 — a connectivity failure must never corrupt persisted state; when
  // this is set, `store.set` was never called this run, and the caller (jira/sync/route.ts)
  // should surface it as a warning, same discipline as every other best-effort fetch in this
  // app (see that route's own `warnings` array).
  error?: string;
}

/** A synthetic single-purpose "previous DailySnapshot" built ONLY from the persisted
 *  assignedIssueKeys, so detectNewAssignments (which diffs `previousSnapshot.workItems` by
 *  `.id`/`.ownerId`) can run completely unmodified against server-side persisted state.
 *  `WorkItem.id` for any Jira-sourced item is deterministically `jira-${key}` (see
 *  jira/normalize.ts) — never a second id scheme invented here. Every other WorkItem field is
 *  a safe, never-read placeholder — detectNewAssignments only ever reads `.id` and `.ownerId`. */
function syntheticPreviousSnapshot(assignedIssueKeys: string[], accountId: string, today: string): DailySnapshot {
  const workItems: WorkItem[] = assignedIssueKeys.map((key) => ({
    id: `jira-${key}`,
    key,
    title: "",
    projectId: "",
    clientId: "",
    type: "task",
    status: "Not Started",
    priority: "P3",
    ownerId: accountId,
    createdDate: today,
    lastUpdated: today,
    blocked: false,
    dependencyIds: [],
    riskIds: [],
    scopeChangeCount: 0,
  }));
  return { date: today, workItems, risks: [], requirements: [], dependencies: [], projects: [] };
}

/** V2.13 §2 — one mentioning comment's stable identity for dedup. Jira always returns a real
 *  `id` for a genuine comment; the fallback (never expected to actually trigger against a real
 *  Jira instance) keeps this deterministic rather than crashing on an unexpected shape, same
 *  "never assume the ideal shape" discipline as jira/mentions.ts's own ADF walker. */
function commentIdentity(issueKey: string, comment: { id?: string; created?: string }): string {
  return comment.id ?? `${issueKey}:no-id:${comment.created ?? ""}`;
}

interface MentionEntry {
  commentId: string;
  event: MentionEvent;
}

/** Fetches comments for every currently-mentioning issue and pairs each mentioning comment's
 *  stable id with the MentionEvent buildMentionEvents renders for it — calling
 *  buildMentionEvents per-comment (cheap, pure, no extra network call) rather than per-issue
 *  batch, since MentionEvent itself carries no raw comment id to pair back up after the fact.
 *  A single issue's comment-fetch failure is best-effort (never fails the whole check), same
 *  discipline as jira/sync/route.ts's own mention-fetching chain. */
async function collectCurrentMentions(fetchImpl: FetchLike, config: JiraConnectionConfig, accountId: string, issueKeys: string[], today: string): Promise<MentionEntry[]> {
  const entries: MentionEntry[] = [];
  await Promise.all(
    issueKeys.map(async (issueKey) => {
      try {
        const commentsResult = await fetchIssueCommentsWith(fetchImpl, config, issueKey);
        if (!commentsResult.ok) return;
        for (const comment of commentsResult.data) {
          if (!commentMentionsAccount(comment.body, accountId)) continue;
          const [event] = buildMentionEvents(issueKey, [comment], accountId, { baseUrl: config.baseUrl, today });
          if (!event) continue;
          entries.push({ commentId: commentIdentity(issueKey, comment), event });
        }
      } catch {
        // best-effort — a single issue's comment fetch failure never fails the check
      }
    })
  );
  return entries;
}

export async function runServerSideNotifyCheck(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  store: NotifyStateStore,
  slackFetchImpl?: SlackFetchLike
): Promise<ServerNotifyCheckResult> {
  const previous = await store.get();
  const today = new Date().toISOString().slice(0, 10);

  // ----- Fetch current assigned issues (targeted JQL — never the full sync dataset) -----
  const assignedResult = await fetchAssignedIssuesWith(fetchImpl, config, accountId);
  if (!assignedResult.ok) {
    return { notified: 0, skippedColdStart: false, error: assignedResult.error };
  }
  const { workItems: assignedWorkItems } = normalizeIssues(assignedResult.data, { baseUrl: config.baseUrl, today });
  const currentAssignedKeys = assignedWorkItems.map((w) => w.key);

  // ----- Fetch current mentions via the same fetchMentionedIssues/fetchIssueComments/
  // buildMentionEvents chain the browser-triggered sync path already uses (jira/sync/route.ts)
  // — same bulk-fetch-avoidance discipline (comments fetched only per-issue, never in bulk).
  // Scoped by lastCheckedAtIso when available: a real Jira instance bumps an issue's `updated`
  // timestamp when a comment is added, so this is a safe, real narrowing (same reasoning the
  // main sync's own incremental cursor already relies on), not a guess. -----
  const mentionedResult = await fetchMentionedIssuesWith(fetchImpl, config, accountId, previous?.lastCheckedAtIso);
  if (!mentionedResult.ok) {
    return { notified: 0, skippedColdStart: false, error: mentionedResult.error };
  }
  const mentionEntries = await collectCurrentMentions(fetchImpl, config, accountId, mentionedResult.data.map((i) => i.key), today);
  const currentMentionCommentIds = mentionEntries.map((e) => e.commentId);

  // ----- Cold start (§2 Task 2 point 1): first-ever run for this install. Write the baseline,
  // send zero notifications — the exact same discipline as V2.10.1's client-side fix, now also
  // true for this unattended path. -----
  if (previous === null) {
    await store.set({ assignedIssueKeys: currentAssignedKeys, notifiedCommentIds: currentMentionCommentIds, lastCheckedAtIso: new Date().toISOString() });
    return { notified: 0, skippedColdStart: true };
  }

  // ----- Diff against the persisted baseline -----
  const currentData: CommandCenterData = { ...emptyData(), workItems: assignedWorkItems };
  const previousSnapshot = syntheticPreviousSnapshot(previous.assignedIssueKeys, accountId, today);
  const newAssignments = detectNewAssignments(currentData, previousSnapshot, accountId);

  const previousCommentIds = new Set(previous.notifiedCommentIds);
  const newMentionEntries = mentionEntries.filter((e) => !previousCommentIds.has(e.commentId));

  // ----- Send each new signal through the SAME Slack-rendering code the browser-triggered
  // /api/command-center/notify/route.ts uses (slack-notify.ts) — never a second copy. -----
  const signals: SlackSignal[] = [
    ...newAssignments.map((a): SlackSignal => ({ issueKey: a.issueKey, summary: a.title, kind: "ASSIGNMENT", detail: `${a.issueKey} was assigned to you since the last check.` })),
    ...newMentionEntries.map(({ event }): SlackSignal => ({
      issueKey: event.issueKey,
      summary: event.commentAuthor ? `Mentioned by ${event.commentAuthor}` : "Mentioned in a comment",
      url: event.commentUrl,
      kind: "MENTION",
      detail: event.excerpt,
    })),
  ];

  // Best-effort — matching the existing route's "one signal's failure doesn't fail the
  // others" discipline. With no SLACK_WEBHOOK_URL configured (webhookUrl undefined, resolved
  // by the caller), this simply delivers nothing; state tracking (below) still advances so a
  // later-configured webhook starts from the real current baseline rather than re-flooding
  // every signal accumulated while unconfigured.
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  let delivered = 0;
  if (webhookUrl) {
    for (const signal of signals) {
      if ((await postToSlack(webhookUrl, renderSlackText(signal), slackFetchImpl)).ok) delivered++;
    }
  }

  const nextState: PersonalNotifyState = {
    assignedIssueKeys: currentAssignedKeys,
    notifiedCommentIds: currentMentionCommentIds,
    lastCheckedAtIso: new Date().toISOString(),
  };
  await store.set(nextState);

  return { notified: delivered, skippedColdStart: false };
}
