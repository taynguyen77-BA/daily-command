// F3 — mention reply auto-detection: on sync, my own comment on the issue that is newer than the
// mention marks the mention replied (source "jira"); the manual "Replied" stays.
// Run through scripts/tests/run.mts (npm test).

import { CommandCenterStore, getTodayIso, parseStoredState } from "../../src/lib/command-center/store";
import { addDays } from "../../src/lib/command-center/date-utils";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { detectRepliedMentions, isMentionReplied } from "../../src/lib/command-center/mention-replies";
import { emptyData, type MentionEvent, type MyTicketActivity } from "../../src/lib/command-center/types";
import type { DataSourceSyncResult } from "../../src/lib/command-center/datasource/types";
import { ok } from "./harness.mts";
import { v226Actionable } from "./helpers.mts";

const m = (issueKey: string, commentId: string, mentionedAt: string): MentionEvent => ({ issueKey, commentId, excerpt: "@Tay can you check?", commentAuthor: "Anna", mentionedAt });

// ----- Pure rule -----
{
  const group = "F3 Reply detection rule";
  const mentions = [m("RP-1", "c1", "2026-10-05T09:00:00.000Z"), m("RP-2", "c2", "2026-10-05T09:00:00.000Z"), m("RP-3", "c3", "2026-10-05T09:00:00.000Z"), m("RP-4", "c4", "2026-10-05T09:00:00.000Z")];
  const activity: Record<string, MyTicketActivity> = {
    "RP-1": { lastCommentAt: "2026-10-05T10:00:00.000Z" }, // replied after → replied
    "RP-2": { lastCommentAt: "2026-10-04T10:00:00.000Z" }, // only an older comment → not
    "RP-3": { lastActivityAt: "2026-10-06T10:00:00.000Z" }, // a transition, not a comment → not
    "RP-4": { lastCommentAt: "2026-10-05T11:00:00.000Z" }, // replied, but already marked by hand
  };
  const manual = { c4: { commentId: "c4", issueKey: "RP-4", repliedAt: "2026-10-05T09:30:00.000Z", source: "manual" as const } };
  const found = detectRepliedMentions(mentions, activity, manual);
  ok(group, Object.keys(found).join() === "c1", `only a NEWER comment of mine on the same issue counts (${Object.keys(found).join()})`);
  ok(group, found.c1.source === "jira" && found.c1.repliedAt === "2026-10-05T10:00:00.000Z" && found.c1.issueKey === "RP-1", "recorded as source 'jira', at my comment's time");
  ok(group, !("c4" in found), "a mention already marked Replied by hand is never touched");
  ok(group, Object.keys(detectRepliedMentions(mentions, activity, { ...manual, ...found })).length === 0, "idempotent: a second sync adds nothing");
}

// ----- On sync, through the real store -----
{
  const group = "F3 Reply detection on sync";
  const Y = addDays(getTodayIso(), -1); // yesterday — inside the reply window
  let payload: DataSourceSyncResult;
  const store = new CommandCenterStore({
    stateStorage: createMemoryStateStorage(),
    stateChannel: null,
    stateFocusTargets: [],
    jiraSyncLockManager: null,
    createJiraDataSource: () => ({ type: "jira", sync: async () => payload }),
  });
  store.getSnapshot();
  store.setPersonalIdentity({ displayName: "Tay", accountId: "acc-tay" });
  store.setJiraStatusRelevance("In Progress", "ACTIONABLE");
  const items = ["RP-1", "RP-2"].map((k) => v226Actionable(k));
  const mentions = [m("RP-1", "RP-1:c1", `${Y}T09:00:00.000Z`), m("RP-2", "RP-2:c2", `${Y}T09:00:00.000Z`)];
  const sync = (myActivity: Record<string, MyTicketActivity>) => {
    payload = { ok: true, data: { ...emptyData(), workItems: items }, recordsFetched: items.length, truncated: false, syncedAt: new Date().toISOString(), warnings: [], mentionEvents: mentions, myActivity };
    return store.syncJira();
  };
  await sync({});
  ok(group, Object.keys(store.getSnapshot().mentionReplies).length === 0, "no reply of mine yet → nothing recorded");
  ok(group, store.buildLiveStandup().mentionsAwaitingReply.some((t) => t.key === "RP-1"), "sanity: RP-1's mention is awaiting my reply");
  store.markMentionReplied("RP-2:c2", "RP-2", `${Y}T09:10:00.000Z`);
  await sync({ "RP-1": { lastCommentAt: `${Y}T12:00:00.000Z` }, "RP-2": { lastCommentAt: `${Y}T12:00:00.000Z` } });
  const replies = store.getSnapshot().mentionReplies;
  ok(group, replies["RP-1:c1"]?.source === "jira" && replies["RP-1:c1"].repliedAt === `${Y}T12:00:00.000Z`, "the next sync marks the answered mention replied, source 'jira'");
  ok(group, replies["RP-2:c2"]?.source === "manual" && replies["RP-2:c2"].repliedAt === `${Y}T09:10:00.000Z`, "the manual 'Replied' stays as it was");
  ok(group, parseStoredState(JSON.stringify(store.getSnapshot())).mentionReplies["RP-1:c1"]?.source === "jira", "persisted (and part of the cross-device synced slice)");
  ok(group, store.buildLiveStandup().mentionsAwaitingReply.every((t) => t.key !== "RP-1"), "it leaves 'Mentions awaiting my reply'");
  ok(group, !!isMentionReplied(mentions[0], replies, {}), "…and stays answered even without the activity record");

  store.setFeatureToggle("mentionReplyTracking", false);
  const before = JSON.stringify(store.getSnapshot().mentionReplies);
  mentions.push(m("RP-1", "RP-1:c9", `${Y}T10:00:00.000Z`));
  await sync({ "RP-1": { lastCommentAt: `${Y}T13:00:00.000Z` } });
  ok(group, JSON.stringify(store.getSnapshot().mentionReplies) === before, "with Mention reply tracking switched off, nothing is recorded");
}
