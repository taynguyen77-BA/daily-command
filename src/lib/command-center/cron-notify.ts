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
import { buildMentionEvents, commentMentionsAccount, latestOwnCommentAt } from "./jira/mentions";
import { normalizeIssues } from "./jira/normalize";
import { fetchAssignedIssuesWith, fetchIssueCommentsWith, fetchMentionedIssuesWith, fetchMyTimeZoneWith, type FetchLike } from "./jira/http";
import type { JiraConnectionConfig } from "./jira/types";
import { postToSlack, renderSlackText, type SlackFetchLike, type SlackSignal } from "../server/slack-notify";
import type { NotifyStateStore, PersonalNotifyState } from "./notify-state";
import { asNotifyPrefs, isDefaultNotifyPrefs, type NotifyPrefsStore } from "./notify-prefs";
import type { DigestStore } from "./notify-digest";
import { runSmartDelivery } from "./cron-notify-smart";
import type { TicketUrgencyFacts } from "./notify-severity";
import { jiraConcurrency, mapWithConcurrency } from "./jira/concurrency";
import { fifoUnion, keysToFetch, MAX_NOTIFIED_COMMENT_IDS, MAX_RETRY_ISSUE_KEYS, nextRetryKeys } from "./notify-baseline";
import { applyDeliveryOutcomes, assignmentSignalId, DEFAULT_MAX_PER_RUN, mentionSignalId, type DeliveryOutcome } from "./notify-delivery";

export interface ServerNotifyCheckResult {
  notified: number;
  skippedColdStart: boolean;
  // V2.13 §2 Task 2 point 3 — a connectivity failure must never corrupt persisted state; when
  // this is set, `store.set` was never called this run, and the caller (jira/sync/route.ts)
  // should surface it as a warning, same discipline as every other best-effort fetch in this
  // app (see that route's own `warnings` array).
  error?: string;
  /** C1 — signals whose Slack post failed and that will be re-announced next run. */
  undelivered?: number;
  /** C1 — signals given up on this run after too many failed posts. */
  droppedUndelivered?: number;
  /** C1 — the last Slack error of this run. */
  lastSlackError?: string;
  /** C1 — when the current Slack failure streak began. */
  undeliveredSince?: string;
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

export interface MentionEntry {
  commentId: string;
  event: MentionEvent;
}

/** Fetches comments for every currently-mentioning issue and builds the MentionEvent for each
 *  one that actually mentions `accountId` — calling buildMentionEvents per-comment (cheap,
 *  pure, no extra network call) rather than per-issue batch. `event.commentId` (V2.17 §1a) is
 *  the same stable per-comment identity mentions.ts's mentionCommentId derives, so this no
 *  longer needs a second, locally-duplicated identity function. A single issue's comment-fetch
 *  failure is best-effort (never fails the whole check), same discipline as
 *  jira/sync/route.ts's own mention-fetching chain. */
/** Exported for server-daily-report.ts (E4), which needs the same per-comment mention list.
 *  P1.1 — also reports `failedKeys` (issues whose comment fetch failed or threw) so the caller can
 *  retry them next run instead of losing the mention once its cursor advances. */
export async function collectCurrentMentions(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  issueKeys: string[],
  today: string,
  /** P2.1 — bounded concurrency (default JIRA_CONCURRENCY / 5); keys not started before `deadline` count as failed (retried next run). */
  options: { concurrency?: number; deadline?: number } = {}
): Promise<{ entries: MentionEntry[]; failedKeys: string[]; /** P3.5 — my newest own comment per issue among the comments fetched. */ ownLastAt: Record<string, string> }> {
  const entries: MentionEntry[] = [];
  const failed = new Set<string>();
  const ownLastAt: Record<string, string> = {};
  const run = await mapWithConcurrency(
    issueKeys,
    options.concurrency ?? jiraConcurrency(),
    async (issueKey) => {
      try {
        const commentsResult = await fetchIssueCommentsWith(fetchImpl, config, issueKey);
        if (!commentsResult.ok) {
          failed.add(issueKey);
          return;
        }
        const own = latestOwnCommentAt(commentsResult.data, accountId);
        if (own) ownLastAt[issueKey] = own;
        for (const comment of commentsResult.data) {
          if (!commentMentionsAccount(comment.body, accountId)) continue;
          const [event] = buildMentionEvents(issueKey, [comment], accountId, { baseUrl: config.baseUrl, today });
          if (!event) continue;
          entries.push({ commentId: event.commentId, event });
        }
      } catch {
        // best-effort — a single issue's comment fetch failure never fails the check
        failed.add(issueKey);
      }
    },
    { deadline: options.deadline }
  );
  for (const i of run.skipped) failed.add(issueKeys[i]);
  return { entries, failedKeys: issueKeys.filter((k) => failed.has(k)), ownLastAt };
}

const ZONE_RECHECK_MS = 7 * 86_400_000;
const isFresh = (checkedAtIso: string | undefined, now: Date) => !!checkedAtIso && now.getTime() - new Date(checkedAtIso).getTime() < ZONE_RECHECK_MS;

export async function runServerSideNotifyCheck(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  store: NotifyStateStore,
  slackFetchImpl?: SlackFetchLike,
  /** L4 — the destination for this run (a member's own webhook, the team one, or null for
   *  none). Omitted (team sign-in off): SLACK_WEBHOOK_URL, as before. */
  options: {
    webhookUrl?: string | null;
    /** P1.1 — the Jira user's UTC offset, for the `updated >=` cursor (see jira/http.ts formatJqlSince). */
    timezoneOffsetMinutes?: number;
    /** C1 — the Jira user's IANA zone (DST-aware); wins over the offset for the cursor. */
    timeZone?: string;
    /** C1 — separate Slack messages per run on the default path (default 10). */
    maxPerRun?: number;
    /** C1 — set false to skip the /myself lookup (the caller already knows the zone or wants no extra request). */
    learnTimeZone?: boolean;
    /** P3.5 — smart notifications: preferences + digest queue. Omitted = exactly the V2.41 behaviour (every signal at once). */
    smart?: { prefsStore: NotifyPrefsStore; digestStore: DigestStore };
    /** Injectable clock (tests). */
    now?: Date;
  } = {}
): Promise<ServerNotifyCheckResult> {
  const previous = await store.get();
  const nowDate = options.now ?? new Date();
  const today = nowDate.toISOString().slice(0, 10);

  // C1 — the zone for the `updated >=` cursor: an explicit one (env / member profile) wins; otherwise the one learned
  // from /myself, cached in this record and re-checked weekly. Best-effort: unknown -> offset -> safe day-level fallback.
  let timeZone = options.timeZone ?? (previous?.jiraTimeZone && isFresh(previous.jiraTimeZoneCheckedAt, nowDate) ? previous.jiraTimeZone : undefined);
  let learned: Pick<PersonalNotifyState, "jiraTimeZone" | "jiraTimeZoneCheckedAt"> = previous?.jiraTimeZone ? { jiraTimeZone: previous.jiraTimeZone, ...(previous.jiraTimeZoneCheckedAt ? { jiraTimeZoneCheckedAt: previous.jiraTimeZoneCheckedAt } : {}) } : {};
  if (!options.timeZone && !timeZone && options.learnTimeZone !== false) {
    const fetched = await fetchMyTimeZoneWith(fetchImpl, config);
    if (fetched) {
      timeZone = fetched;
      learned = { jiraTimeZone: fetched, jiraTimeZoneCheckedAt: nowDate.toISOString() };
    } else if (previous?.jiraTimeZone) {
      timeZone = previous.jiraTimeZone; // stale beats unknown
    }
  }

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
  const mentionedResult = await fetchMentionedIssuesWith(fetchImpl, config, accountId, previous?.lastCheckedAtIso, undefined, options.timezoneOffsetMinutes, timeZone);
  if (!mentionedResult.ok) {
    return { notified: 0, skippedColdStart: false, error: mentionedResult.error };
  }
  // Issues whose comments failed last run are fetched again even if the JQL no longer matches them.
  const { entries: mentionEntries, failedKeys, ownLastAt } = await collectCurrentMentions(fetchImpl, config, accountId, keysToFetch(mentionedResult.data.map((i) => i.key), previous?.retryIssueKeys), today);
  const retryIssueKeys = nextRetryKeys(previous?.retryIssueKeys, failedKeys);
  const currentMentionCommentIds = mentionEntries.map((e) => e.commentId);

  // ----- Cold start (§2 Task 2 point 1): first-ever run for this install. Write the baseline,
  // send zero notifications — the exact same discipline as V2.10.1's client-side fix, now also
  // true for this unattended path. -----
  if (previous === null) {
    await store.set({
      assignedIssueKeys: currentAssignedKeys,
      notifiedCommentIds: fifoUnion([], currentMentionCommentIds, MAX_NOTIFIED_COMMENT_IDS),
      lastCheckedAtIso: nowDate.toISOString(),
      ...(retryIssueKeys.length > 0 ? { retryIssueKeys } : {}),
      ...learned,
    });
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
  const webhookUrl = "webhookUrl" in options ? options.webhookUrl : process.env.SLACK_WEBHOOK_URL;
  let delivered = 0;
  const outcomes: DeliveryOutcome[] = [];
  let lastSlackError: string | undefined;

  // P3.5 — smart notifications. Used only when the caller supplied the stores AND the user's preferences are not the
  // defaults, or a digest is already waiting; otherwise the loop below is exactly the V2.41 behaviour.
  const prefs = options.smart ? asNotifyPrefs(await options.smart.prefsStore.get()) : null;
  const digest = options.smart ? await options.smart.digestStore.get() : null;
  let smartExtras: Pick<PersonalNotifyState, "pendingMentions" | "escalatedCommentIds"> = {};
  if (options.smart && prefs && digest && webhookUrl && (!isDefaultNotifyPrefs(prefs) || digest.items.length > 0)) {
    const now = nowDate;
    const facts = new Map<string, TicketUrgencyFacts & { url?: string }>();
    for (const w of [...assignedWorkItems, ...normalizeIssues(mentionedResult.data, { baseUrl: config.baseUrl, today }).workItems]) facts.set(w.key, { priority: w.priority, dueDate: w.dueDate, blocked: w.blocked, ...(w.sourceUrl ? { url: w.sourceUrl } : {}) });
    const run = await runSmartDelivery({
      prefs,
      digest,
      now,
      offsetMinutes: options.timezoneOffsetMinutes ?? 0,
      today,
      assignments: newAssignments,
      mentions: newMentionEntries,
      facts,
      previousPending: previous.pendingMentions ?? [],
      previousEscalated: previous.escalatedCommentIds ?? [],
      ownLastAt,
      fetchOwnLast: async (keys) => (await collectCurrentMentions(fetchImpl, config, accountId, keys, today)).ownLastAt,
      send: async (text) => (await postToSlack(webhookUrl, text, slackFetchImpl)).ok,
    });
    delivered = run.delivery.delivered;
    await options.smart.digestStore.set(run.delivery.digest);
    smartExtras = { ...(run.pendingMentions.length > 0 ? { pendingMentions: run.pendingMentions } : {}), ...(run.escalatedCommentIds.length > 0 ? { escalatedCommentIds: run.escalatedCommentIds } : {}) };
  } else if (webhookUrl) {
    // C1 — a signal is notified only if its post succeeded. Failed (and flood-deferred) signals stay "new".
    const maxPerRun = options.maxPerRun && options.maxPerRun > 0 ? options.maxPerRun : DEFAULT_MAX_PER_RUN;
    const ids = [...newAssignments.map((a) => assignmentSignalId(a.issueKey)), ...newMentionEntries.map((e) => mentionSignalId(e.commentId))];
    const now = ids.length > maxPerRun ? signals.slice(0, maxPerRun) : signals;
    for (let i = 0; i < signals.length; i++) {
      if (i >= now.length) {
        outcomes.push({ id: ids[i], status: "deferred" });
        continue;
      }
      const res = await postToSlack(webhookUrl, renderSlackText(signals[i]), slackFetchImpl);
      if (res.ok) {
        delivered++;
        outcomes.push({ id: ids[i], status: "delivered" });
      } else {
        lastSlackError = res.detail ?? "Slack post failed";
        outcomes.push({ id: ids[i], status: "failed" });
      }
    }
    const deferredCount = signals.length - now.length;
    if (deferredCount > 0) {
      const rest = signals.slice(now.length);
      const keys = Array.from(new Set(rest.map((sg) => sg.issueKey)));
      await postToSlack(webhookUrl, `➕ +${deferredCount} more: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""} (delivered over the next checks)`, slackFetchImpl); // best-effort notice; the signals themselves stay pending
    }
  }

  const update = applyDeliveryOutcomes(previous.deliveryAttempts, outcomes);
  for (const id of update.dropped) console.warn(`[notify] dropped undelivered signal ${id} after repeated Slack failures`);
  const pendingMentionIds = new Set(newMentionEntries.filter((e) => update.pending.has(mentionSignalId(e.commentId))).map((e) => e.commentId));
  const pendingAssignKeys = new Set(newAssignments.filter((a) => update.pending.has(assignmentSignalId(a.issueKey))).map((a) => a.issueKey));
  const undelivered = update.pending.size;
  const undeliveredSince = undelivered > 0 ? previous.undeliveredSince ?? nowDate.toISOString() : undefined;
  // Mentions still owed are re-fetched next run even if the JQL no longer matches their ticket.
  const owedKeys = newMentionEntries.filter((e) => pendingMentionIds.has(e.commentId)).map((e) => e.event.issueKey);
  const retryWithOwed = fifoUnion(retryIssueKeys, owedKeys, MAX_RETRY_ISSUE_KEYS);

  const nextState: PersonalNotifyState = {
    // An undelivered assignment is left out so it diffs as new again next run.
    assignedIssueKeys: currentAssignedKeys.filter((k) => !pendingAssignKeys.has(k)),
    // A UNION, not this run's ids: a run only sees issues updated since the last check, so
    // overwriting would forget older mentions and re-announce them when their ticket is touched again.
    // An undelivered mention is left out so it is announced once Slack is back.
    notifiedCommentIds: fifoUnion(previous.notifiedCommentIds, currentMentionCommentIds.filter((id) => !pendingMentionIds.has(id)), MAX_NOTIFIED_COMMENT_IDS),
    lastCheckedAtIso: nowDate.toISOString(),
    ...(retryWithOwed.length > 0 ? { retryIssueKeys: retryWithOwed } : {}),
    ...(update.attempts.length > 0 ? { deliveryAttempts: update.attempts } : {}),
    ...(undeliveredSince ? { undeliveredSince } : {}),
    ...learned,
    ...smartExtras,
  };
  await store.set(nextState);

  return {
    notified: delivered,
    skippedColdStart: false,
    ...(undelivered > 0 ? { undelivered } : {}),
    ...(update.dropped.length > 0 ? { droppedUndelivered: update.dropped.length } : {}),
    ...(lastSlackError ? { lastSlackError } : {}),
    ...(undeliveredSince ? { undeliveredSince } : {}),
  };
}
