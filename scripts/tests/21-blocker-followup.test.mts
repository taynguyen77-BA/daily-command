// F2 — blocker follow-up quality: age in business days, "Ask" grouped by person (copy, Slack only
// after confirm), configurable SLA, overdue blockers first in Today and in the Daily Report.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterStore, parseStoredState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { blockedAgeBusinessDays, blockedFollowUpRows, groupAskByPerson, isBlockerOverdue, overdueBlockers } from "../../src/lib/command-center/blocker-followup";
import { needsFromOthersForBlockedTicket, renderNeedsFromOthersText } from "../../src/lib/command-center/communicate";
import { buildMyWork } from "../../src/lib/command-center/my-work";
import { buildDailyReportView, renderDailyReport, type StandupState } from "../../src/lib/command-center/reports";
import { TaskReferenceRowView } from "../../src/components/command-center/TaskReferenceRow";
import { AskFollowUp } from "../../src/components/command-center/AskFollowUp";
import { DEFAULT_FEATURE_TOGGLES, emptyData, type TicketWorkState, type WorkItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { makeItem } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
// Local-time timestamps (no Z) so business-day counting doesn't depend on the machine's TZ.
const MON = "2026-10-05T10:00:00";
const blocked = (ticketKey: string, at: string, reason?: string): TicketWorkState => ({ ticketKey, status: "BLOCKED", updatedAt: new Date(at).toISOString(), history: [], ...(reason ? { reason } : {}) });

// ----- Age and SLA -----
{
  const group = "F2 Blocker age & SLA";
  ok(group, blockedAgeBusinessDays(new Date(MON).toISOString(), "2026-10-05") === 0, "blocked today → 0 business days");
  ok(group, blockedAgeBusinessDays(new Date(MON).toISOString(), "2026-10-07") === 2, "Monday → Wednesday = 2 business days");
  ok(group, blockedAgeBusinessDays(new Date("2026-10-02T10:00:00").toISOString(), "2026-10-05") === 1, "Friday → Monday = 1 (weekends never count)");
  ok(group, blockedAgeBusinessDays(undefined, "2026-10-05") === undefined && blockedAgeBusinessDays("garbage", "2026-10-05") === undefined, "no/invalid timestamp → unknown, never guessed");
  ok(group, !isBlockerOverdue(2, 2) && isBlockerOverdue(3, 2) && !isBlockerOverdue(undefined, 2), "overdue = MORE business days than the SLA");
  const states = { A: blocked("A-1", MON, "Waiting on Anna"), B: blocked("B-1", "2026-10-01T10:00:00"), C: blocked("C-1", "2026-10-08T10:00:00"), D: { ...blocked("D-1", MON), status: "SKIPPED" as const } };
  const over = overdueBlockers({ "A-1": states.A, "B-1": states.B, "C-1": states.C, "D-1": states.D }, "2026-10-09", 2);
  ok(group, over.map((o) => `${o.ticketKey}:${o.ageBusinessDays}`).join() === "B-1:6,A-1:4", `only BLOCKED tickets past the SLA, oldest first (${over.map((o) => `${o.ticketKey}:${o.ageBusinessDays}`).join()})`);
  ok(group, over[1].reason === "Waiting on Anna", "carries the block reason");

  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  ok(group, store.getSnapshot().blockerSlaBusinessDays === 2 && DEFAULT_FEATURE_TOGGLES.blockerFollowUp === true, "SLA defaults to 2 business days; the feature defaults on");
  store.setBlockerSla(5);
  ok(group, parseStoredState(JSON.stringify(store.getSnapshot())).blockerSlaBusinessDays === 5, "the SLA is configurable and remembered");
  store.setBlockerSla(0);
  ok(group, store.getSnapshot().blockerSlaBusinessDays === 2 && parseStoredState(JSON.stringify({ blockerSlaBusinessDays: 99 })).blockerSlaBusinessDays === 2, "out-of-range values (outside 1–30) fall back to the default");
  ok(group, /data-blocker-sla/.test(read("src/app/data-settings/page.tsx")) && /store\.setBlockerSla\(/.test(read("src/app/data-settings/page.tsx")), "set in Data & Settings");
}

// ----- "Ask": Needs From Others rows grouped by person -----
{
  const group = "F2 Ask follow-up";
  const w1 = makeItem({ id: "w-1", key: "PAY-3", title: "Card vault" });
  const w2 = makeItem({ id: "w-2", key: "PAY-4", title: "Refunds" });
  const w3 = makeItem({ id: "w-3", key: "OPS-1", title: "Infra" });
  const data = {
    workItems: [w1, w2, w3],
    dependencies: [
      { id: "d1", workItemId: "w-1", description: "API keys", dependsOnTeam: "Platform", status: "unresolved" as const, raisedDate: "2026-10-01" },
      { id: "d2", workItemId: "w-2", description: "Refund API", dependsOnTeam: "Platform", status: "unresolved" as const, raisedDate: "2026-10-01" },
      { id: "d3", workItemId: "w-2", description: "Legal sign-off", dependsOnTeam: "Legal", status: "unresolved" as const, raisedDate: "2026-10-01" },
      { id: "d4", workItemId: "w-3", description: "done already", dependsOnTeam: "Ops", status: "resolved" as const, raisedDate: "2026-10-01" },
    ],
  };
  const states = { "PAY-3": blocked("PAY-3", MON, "keys"), "PAY-4": blocked("PAY-4", MON), "OPS-1": blocked("OPS-1", MON, "Waiting on client decision") };
  const rows = blockedFollowUpRows(states, data);
  ok(group, rows.length === 4, `one row per unresolved dependency team, plus a "who?" row for a block with none (${rows.length})`);
  const groups = groupAskByPerson(rows);
  ok(group, groups.map((g) => `${g.person}:${g.rows.length}`).join() === "Legal:1,Platform:2,UNKNOWN:1", `grouped by person — Platform gets ONE message for both tickets; unknown recipient last (${groups.map((g) => `${g.person}:${g.rows.length}`).join()})`);
  ok(group, groups.every((g) => g.text === renderNeedsFromOthersText(g.rows)) && /PAY-3/.test(groups[1].text) && /PAY-4/.test(groups[1].text), "each message is the Needs From Others text for that person's rows");
  ok(group, groups[2].isUnknownPerson && /OPS-1/.test(groups[2].text) && /Waiting on client decision/.test(groups[2].text), "a block with no owner keeps its reason and asks 'who?'");

  const single = needsFromOthersForBlockedTicket({ key: "PAY-3", title: "Card vault" }, "keys", [data.dependencies[0]]);
  let sends = 0;
  const send = async () => (sends++, { sent: true });
  const closed = renderToStaticMarkup(React.createElement(AskFollowUp, { rows: single, send }));
  ok(group, />Ask<\/button>/.test(closed) && !/data-ask-person/.test(closed), "collapsed: a single 'Ask' button");
  const open = renderToStaticMarkup(React.createElement(AskFollowUp, { rows: rows, send, initialOpen: true }));
  ok(group, (open.match(/data-ask-person=/g) ?? []).length === 3 && (open.match(/>Copy<\/button>/g) ?? []).length === 3 && (open.match(/>Send via Slack…<\/button>/g) ?? []).length === 3, "open: one message per person, each with Copy and 'Send via Slack…'");
  ok(group, !/Yes, send/.test(open), "no send button until 'Send via Slack…' is clicked");
  const confirming = renderToStaticMarkup(React.createElement(AskFollowUp, { rows, send, initialOpen: true, initialConfirming: "Platform" }));
  ok(group, (confirming.match(/data-ask-confirm/g) ?? []).length === 1 && /Send this message to the Slack channel configured on the server\?/.test(confirming) && />Yes, send<\/button>/.test(confirming), "an explicit second confirmation, for that person only");
  ok(group, sends === 0, "rendering never sends anything");
  const src = read("src/components/command-center/AskFollowUp.tsx");
  ok(group, (src.match(/doSend\(/g) ?? []).length === 2 && /confirming === g\.person \? \([\s\S]*?doSend\(g\.person, g\.text\)/.test(src), "the only send call sits behind the confirmation");
}

// ----- TaskRow: blocked rows show age vs SLA and the "Ask" -----
{
  const group = "F2 Blocked row";
  const rows = needsFromOthersForBlockedTicket({ key: "PAY-3" }, "keys", []);
  const html = (blocker?: { ageBusinessDays: number; slaBusinessDays: number }) =>
    renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "PAY-3", execution: { kind: "blocked", at: new Date(MON).toISOString(), reason: "keys" }, followUpRows: rows, blocker, actions: { onComplete() {}, onSkip() {}, onBlock() {}, onReopen() {}, onReactivateSkip() {}, onUnblock() {} } }));
  const over = html({ ageBusinessDays: 4, slaBusinessDays: 2 });
  ok(group, /data-blocker-age[^>]*text-red[^>]*>Blocked 4 business days — over the 2-day SLA</.test(over), "over SLA: 'Blocked 4 business days — over the 2-day SLA', in red");
  ok(group, /Blocked 1 business day \(SLA 2\)/.test(html({ ageBusinessDays: 1, slaBusinessDays: 2 })), "within SLA: the age with the SLA for reference");
  ok(group, /data-ask-follow-up/.test(over) && !/data-follow-up[^-]/.test(over), "blocked rows offer 'Ask' (feature on)");
  const off = html(undefined);
  ok(group, !/data-blocker-age/.test(off) && /Draft follow-up/.test(off), "feature off: the previous copy-only draft, no age line");
}

// ----- Overdue blockers lead Today / Blocked, and the Daily Report header -----
{
  const group = "F2 Overdue first";
  const today = "2026-10-09";
  const wi = (key: string): WorkItem => ({ ...makeItem({ id: `jira-${key}`, key, owner: "Tay", ownerId: "acc-tay" }), sourceType: "jira", sourceId: key });
  const states = { "OLD-1": blocked("OLD-1", "2026-10-01T10:00:00"), "NEW-1": blocked("NEW-1", "2026-10-09T09:00:00"), "MID-1": blocked("MID-1", MON) };
  const base = { workItems: ["OLD-1", "NEW-1", "MID-1"].map(wi), identity: { accountId: "acc-tay", displayName: "Tay" }, ticketWorkStates: states, today };
  const withSla = buildMyWork({ ...base, blockerSlaBusinessDays: 2 });
  ok(group, withSla.views.blocked.map((r) => r.ticketKey).join() === "OLD-1,MID-1,NEW-1", `Blocked view: overdue first, oldest first (${withSla.views.blocked.map((r) => r.ticketKey).join()})`);
  ok(group, withSla.overdueBlockers.map((r) => `${r.ticketKey}:${r.blockedAgeBusinessDays}`).join() === "OLD-1:6,MID-1:4", "Today gets the overdue blockers (pointers; rows stay in Blocked)");
  ok(group, withSla.views.today.every((r) => r.view.status !== "BLOCKED"), "the rows themselves are not duplicated into Today");
  ok(group, buildMyWork(base).overdueBlockers.length === 0, "no SLA passed (feature off) → no overdue list");
  const page = read("src/app/my-work/page.tsx");
  ok(group, page.indexOf("data-overdue-blockers") < page.indexOf("<YourDeliveryFocus") && /view === "today" && work\.overdueBlockers\.length > 0/.test(page), "My Work → Today shows 'Overdue blockers' first, above the focus list");
  ok(group, /data-ask-everyone/.test(page) && /blockedFollowUpRows\(state\.ticketWorkStates, filteredData\)/.test(page), "Blocked view offers 'Ask everyone' (one message per person)");

  const standup: StandupState = { asOf: `${today}T09:00:00Z`, inProgress: [], blocked: [{ key: "PAY-3", ageBusinessDays: 6, notes: ["Waiting on Anna"] }, { key: "PAY-9", ageBusinessDays: 1 }], skipped: [], newToday: [], mentionsAwaitingReply: [], openAssigned: [] };
  const view = buildDailyReportView({ date: today, generatedAt: `${today}T18:00:00Z`, events: [], standup }, today, { accountId: "acc-tay" }, undefined, { blockerSlaBusinessDays: 2 });
  ok(group, view.overdueBlockers?.map((t) => t.key).join() === "PAY-3", "the Daily Report knows which blockers are over the SLA");
  const md = renderDailyReport(view, "markdown").split("\n");
  ok(group, md[0] === "# Daily Report — 2026-10-09" && md[2] === "**⚠ 1 blocker over the 2-business-day SLA: PAY-3 (6d)**", `…and says so in the header, right under the title ("${md[2]}")`);
  const plain = buildDailyReportView({ date: today, generatedAt: `${today}T18:00:00Z`, events: [], standup }, today, { accountId: "acc-tay" });
  ok(group, plain.overdueBlockers === undefined && !renderDailyReport(plain, "markdown").includes("SLA"), "feature off → the report is unchanged");
  ok(group, /OverdueBlockersCallout tickets=\{v\.overdueBlockers\}/.test(read("src/app/reports/page.tsx")), "the Reports page shows the same callout");
}
void emptyData;
