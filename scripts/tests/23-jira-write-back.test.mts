// F4 — optional Jira write-back: OFF by default, per-project allow-list, preview + confirmation
// for every write, every attempt logged, never a write when off / not allow-listed.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterStore, parseStoredState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { blockedCommentText, executeJiraWriteBack, performJiraWrite, planJiraWriteBack, preselectTransition, projectKeyOf, type JiraWriteRequest } from "../../src/lib/command-center/jira/write-back";
import { adfFromText, DisabledJiraActionProvider, HttpJiraActionProvider } from "../../src/lib/command-center/jira/jira-action-provider";
import { JiraWriteBackDialog } from "../../src/components/command-center/JiraWriteBackPrompt";
import { DEFAULT_FEATURE_TOGGLES, DEFAULT_JIRA_WRITE_BACK_SETTINGS, type JiraWriteBackSettings, type JiraWriteLogEntry } from "../../src/lib/command-center/types";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const settings = (over: Partial<JiraWriteBackSettings> = {}): JiraWriteBackSettings => ({ ...DEFAULT_JIRA_WRITE_BACK_SETTINGS, projects: ["PAY"], ...over });
const ON = { jiraWriteBack: true };

// ----- The gate: what may be proposed -----
{
  const group = "F4 Write-back gate";
  ok(group, DEFAULT_FEATURE_TOGGLES.jiraWriteBack === false && DEFAULT_JIRA_WRITE_BACK_SETTINGS.projects.length === 0, "OFF by default, with an empty allow-list");
  ok(group, planJiraWriteBack({ features: { jiraWriteBack: false }, settings: settings(), ticketKey: "PAY-1", trigger: "block", reason: "x" }) === null, "toggle off → nothing is ever proposed, even for an allow-listed project");
  ok(group, planJiraWriteBack({ features: ON, settings: settings(), ticketKey: "OPS-1", trigger: "block" }) === null, "project not on the allow-list → nothing");
  ok(group, planJiraWriteBack({ features: ON, settings: settings({ projects: [] }), ticketKey: "PAY-1", trigger: "done" }) === null, "empty allow-list → nothing");
  ok(group, planJiraWriteBack({ features: ON, settings: settings(), ticketKey: "pay-1", trigger: "block" }) === null && projectKeyOf("NOT A KEY") === undefined, "not a Jira key → nothing");
  const block = planJiraWriteBack({ features: ON, settings: settings(), ticketKey: "PAY-12", trigger: "block", reason: "Waiting on Anna" });
  ok(group, JSON.stringify(block?.writes) === JSON.stringify([{ kind: "comment", text: "Blocked: Waiting on Anna" }]), "Block → a comment 'Blocked: <reason>'");
  ok(group, blockedCommentText(undefined) === "Blocked: no reason given", "…with an honest placeholder when no reason was given");
  const flagged = planJiraWriteBack({ features: ON, settings: settings({ setFlag: true, flagFieldId: "customfield_10021" }), ticketKey: "PAY-12", trigger: "block" });
  ok(group, flagged?.writes.some((w) => w.kind === "flag" && w.fieldId === "customfield_10021"), "Block + 'set Flag' (with the field id) → the Flag too");
  ok(group, !planJiraWriteBack({ features: ON, settings: settings({ setFlag: true }), ticketKey: "PAY-12", trigger: "block" })?.writes.some((w) => w.kind === "flag"), "…never without a field id");
  const done = planJiraWriteBack({ features: ON, settings: settings({ doneTransitions: { PAY: "Done" } }), ticketKey: "PAY-12", trigger: "done" });
  ok(group, JSON.stringify(done?.writes) === JSON.stringify([{ kind: "transition", preferredName: "Done" }]), "Done → a transition, pre-selecting the project's saved choice");
  ok(group, preselectTransition([{ id: "11", name: "In Review" }, { id: "31", name: "Done" }], "done")?.id === "31" && preselectTransition([{ id: "11", name: "x" }], "Done") === undefined, "the saved name matches the ticket's available transitions (case-insensitive), else nothing pre-selected");
}

// ----- Execution: only what was ticked, every attempt logged -----
{
  const group = "F4 Write-back execution";
  const proposal = planJiraWriteBack({ features: ON, settings: settings({ setFlag: true, flagFieldId: "customfield_10021" }), ticketKey: "PAY-12", trigger: "block", reason: "Waiting on Anna" })!;
  const sent: JiraWriteRequest[] = [];
  const log: Omit<JiraWriteLogEntry, "id" | "at">[] = [];
  const okSend = async (r: JiraWriteRequest) => (sent.push(r), { ok: true });
  const none = await executeJiraWriteBack(proposal, {}, okSend, (e) => log.push(e));
  ok(group, none.attempted === 0 && sent.length === 0 && log.length === 0, "nothing ticked → nothing sent, nothing logged");
  await executeJiraWriteBack(proposal, { comment: true, commentText: "Blocked: Waiting on Anna (API keys)" }, okSend, (e) => log.push(e));
  ok(group, sent.length === 1 && sent[0].action === "comment" && (sent[0] as { text: string }).text === "Blocked: Waiting on Anna (API keys)", "only the ticked write is sent — with the text as confirmed in the preview");
  ok(group, log.length === 1 && log[0].ok && log[0].kind === "comment" && log[0].trigger === "block" && log[0].ticketKey === "PAY-12", "…and logged");
  const failing = await executeJiraWriteBack(proposal, { comment: true, flag: true }, async (r) => (r.action === "flag" ? { ok: false, error: "Field not on screen" } : { ok: true }), (e) => log.push(e));
  ok(group, failing.attempted === 2 && failing.failed === 1 && log.at(-1)!.ok === false && log.at(-1)!.error === "Field not on screen", "a failed write is logged with Jira's error, never hidden");
  await executeJiraWriteBack(proposal, { comment: true }, async () => { throw new Error("offline"); }, (e) => log.push(e));
  ok(group, log.at(-1)!.ok === false && log.at(-1)!.error === "offline", "a network failure is logged too");
  const done = planJiraWriteBack({ features: ON, settings: settings(), ticketKey: "PAY-12", trigger: "done" })!;
  sent.length = 0;
  await executeJiraWriteBack(done, { comment: true, flag: true }, okSend, () => undefined);
  ok(group, sent.length === 0, "a Done proposal can't be turned into a comment/flag by the choices");
  await executeJiraWriteBack(done, { transition: { id: "31", name: "Done" } }, okSend, (e) => log.push(e));
  ok(group, sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ action: "transition", issueKey: "PAY-12", transitionId: "31" }) && log.at(-1)!.detail === "Done", "the chosen transition is sent and logged by name");
}

// ----- Store: proposal after a user's Block/Done; never persisted; the history log -----
{
  const group = "F4 Write-back in the store";
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  store.blockTicketInDailyCommand("PAY-1", "x", undefined, undefined, "my-work");
  ok(group, store.getPendingJiraWrite() === null, "feature off (default): blocking proposes nothing");
  store.setFeatureToggle("jiraWriteBack", true);
  store.blockTicketInDailyCommand("PAY-2", "x", undefined, undefined, "my-work");
  ok(group, store.getPendingJiraWrite() === null, "feature on but PAY not allow-listed: nothing");
  store.setJiraWriteBackSettings({ projects: ["PAY", "bad key", "OPS"] });
  ok(group, store.getSnapshot().jiraWriteBack.projects.join() === "PAY,OPS", "the allow-list keeps only real project keys");
  store.blockTicketInDailyCommand("PAY-3", "Waiting on Anna", undefined, undefined, "my-work");
  const p = store.getPendingJiraWrite();
  ok(group, p?.ticketKey === "PAY-3" && p.trigger === "block" && p.writes[0].kind === "comment", "on + allow-listed: Block proposes the comment (for the dialog to confirm)");
  ok(group, store.getSnapshot().jiraWriteLog.length === 0, "a proposal writes nothing and logs nothing by itself");
  ok(group, !("pendingJiraWrite" in parseStoredState(JSON.stringify(store.getSnapshot()))) && !JSON.stringify(store.getSnapshot()).includes('"writes"'), "the proposal is never persisted (a reload drops it)");
  store.clearPendingJiraWrite();
  store.completeTicketInDailyCommand("OPS-7", "my-work");
  ok(group, store.getPendingJiraWrite()?.trigger === "done", "Done proposes a transition");
  store.clearPendingJiraWrite();
  store.startTicket("OPS-8", "my-work");
  store.skipTicketInDailyCommand("OPS-9", undefined, undefined, "my-work");
  ok(group, store.getPendingJiraWrite() === null, "Start/Skip never propose a write");
  store.setTicketStatus("PAY-4", "DONE", { surface: "jira-sync" });
  ok(group, store.getPendingJiraWrite() === null, "a status Jira itself closed is never written back");
  store.recordJiraWrite({ ticketKey: "PAY-3", kind: "comment", detail: "Blocked: Waiting on Anna", ok: true, trigger: "block" });
  const reloaded = parseStoredState(JSON.stringify(store.getSnapshot()));
  ok(group, reloaded.jiraWriteLog.length === 1 && reloaded.jiraWriteLog[0].detail === "Blocked: Waiting on Anna", "every write is kept in the history (persisted)");
  ok(group, parseStoredState(JSON.stringify({ jiraWriteBack: { projects: ["PAY"], flagFieldId: "nope", setFlag: "yes" } })).jiraWriteBack.flagFieldId === undefined && parseStoredState("{}").jiraWriteBack.setFlag === false, "settings parse defensively");
}

// ----- The real provider, against a fake Jira -----
{
  const group = "F4 Jira provider";
  const config = { baseUrl: "https://acme.atlassian.net", email: "me@acme.test", apiToken: "tok" };
  const calls: { url: string; method?: string; body?: string; auth?: string }[] = [];
  const fake = (status = 200, json: unknown = {}): FetchLike => async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
    return { ok: status < 300, status, json: async () => json };
  };
  const p = new HttpJiraActionProvider(fake(201), config);
  await p.addComment("PAY-12", "Blocked: Waiting on Anna");
  ok(group, calls[0].method === "POST" && calls[0].url === "https://acme.atlassian.net/rest/api/3/issue/PAY-12/comment" && calls[0].auth === "Basic " + Buffer.from("me@acme.test:tok").toString("base64"), "comment: POST /issue/{key}/comment with the server's credentials");
  ok(group, JSON.stringify(JSON.parse(calls[0].body!).body) === JSON.stringify(adfFromText("Blocked: Waiting on Anna")) && adfFromText("x").type === "doc", "…as an Atlassian Document Format body");
  await performJiraWrite(new HttpJiraActionProvider(fake(204), config), { action: "flag", issueKey: "PAY-12", fieldId: "customfield_10021" });
  ok(group, calls[1].method === "PUT" && JSON.stringify(JSON.parse(calls[1].body!)) === JSON.stringify({ fields: { customfield_10021: [{ value: "Impediment" }] } }), "flag: PUT the configured Flagged field");
  const list = await performJiraWrite(new HttpJiraActionProvider(fake(200, { transitions: [{ id: "31", name: "Done", to: { name: "Closed" } }, { id: 7 }] }), config), { action: "list-transitions", issueKey: "PAY-12" });
  ok(group, list.ok && JSON.stringify(list.transitions) === JSON.stringify([{ id: "31", name: "Done", toStatus: "Closed" }]), "transitions: read from GET /transitions (malformed entries dropped)");
  await performJiraWrite(new HttpJiraActionProvider(fake(204), config), { action: "transition", issueKey: "PAY-12", transitionId: "31" });
  ok(group, calls.at(-1)!.method === "POST" && JSON.parse(calls.at(-1)!.body!).transition.id === "31", "transition: POST the chosen id");
  const before = calls.length;
  const bad = await performJiraWrite(p, { action: "comment", issueKey: "PAY-12; DROP", text: "x" });
  ok(group, !bad.ok && calls.length === before, "an invalid issue key is refused before any request");
  const rejected = await performJiraWrite(new HttpJiraActionProvider(fake(400, { errorMessages: ["Transition is not valid"] }), config), { action: "transition", issueKey: "PAY-12", transitionId: "99" });
  ok(group, !rejected.ok && /400: Transition is not valid/.test(rejected.error), "a Jira refusal comes back with Jira's message");
  let threw = false;
  try {
    await p.assignIssue();
  } catch {
    threw = true;
  }
  ok(group, threw, "assigning is not part of write-back and stays disabled");
  let disabledThrows = 0;
  for (const call of [() => new DisabledJiraActionProvider().listTransitions(), () => new DisabledJiraActionProvider().addComment()]) {
    try {
      await call();
    } catch {
      disabledThrows++;
    }
  }
  ok(group, disabledThrows === 2, "the Disabled provider (still the default) rejects every call");
}

// ----- Route + dialog -----
{
  const group = "F4 Route & confirmation";
  const route = read("src/app/api/command-center/jira/write/route.ts");
  ok(group, /checkSyncRequestAuth\(req\.headers\.get\("authorization"\)/.test(route) && /z\.discriminatedUnion\("action"/.test(route) && /performJiraWrite\(new HttpJiraActionProvider\(fetch, config\), parsed\.data\)/.test(route), "the write route needs the same auth as every route and validates the body strictly");
  const users = ["src/app", "src/components", "src/lib"].flatMap(function walk(dir: string): string[] {
    return fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && /new HttpJiraActionProvider\(/.test(read(path.join(dir, e.name))) ? [path.join(dir, e.name)] : []));
  });
  ok(group, users.join() === "src/app/api/command-center/jira/write/route.ts", `the real provider is constructed in exactly one place (${users.join()})`);
  const client = read("src/lib/command-center/jira-write-client.ts");
  const callers = ["src/components", "src/app"].flatMap(function walk(dir: string): string[] {
    return fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && /sendJiraWrite/.test(read(path.join(dir, e.name))) ? [path.join(dir, e.name)] : []));
  });
  ok(group, /pairedAuthHeader\(\)/.test(client) && callers.join() === "src/components/command-center/JiraWriteBackPrompt.tsx", "only the confirmation dialog sends writes");
  const prompt = read("src/components/command-center/JiraWriteBackPrompt.tsx");
  ok(group, /executeJiraWriteBack\(proposal, choices, sendJiraWrite, \(e\) => commandCenterStore\.recordJiraWrite\(e\)\)/.test(prompt) && /onClick=\{\(\) => void confirm\(\)\}/.test(prompt), "writes run only from the 'Write to Jira' click, and every one is logged");

  const proposal = planJiraWriteBack({ features: ON, settings: settings({ setFlag: true, flagFieldId: "customfield_10021" }), ticketKey: "PAY-12", trigger: "block", reason: "Waiting on Anna" })!;
  const html = renderToStaticMarkup(React.createElement(JiraWriteBackDialog, { proposal, onClose: () => undefined }));
  ok(group, /Also update PAY-12 in Jira\?/.test(html) && /Nothing is written to Jira unless you confirm below/.test(html) && /Blocked: Waiting on Anna<\/textarea>/.test(html) && /Set the Flag/.test(html) && />Write to Jira<\/button>/.test(html) && />Not now<\/button>/.test(html), "the dialog previews exactly what would be written, with Write to Jira / Not now");
  const done = planJiraWriteBack({ features: ON, settings: settings(), ticketKey: "PAY-12", trigger: "done" })!;
  const doneHtml = renderToStaticMarkup(React.createElement(JiraWriteBackDialog, { proposal: done, onClose: () => undefined, initialTransitions: [{ id: "21", name: "In Review" }, { id: "31", name: "Done", toStatus: "Closed" }] }));
  ok(group, /<option value="" selected="">Don(?:'|&#x27;)t transition<\/option>/.test(doneHtml) && /<option value="31">Done → Closed<\/option>/.test(doneHtml), "Done: the ticket's own available transitions, defaulting to 'Don't transition'");
  ok(group, /disabled=""[^>]*>Write to Jira|Write to Jira<\/button>/.test(doneHtml) && /nothingChosen/.test(prompt), "nothing chosen → nothing to confirm");
  const ds = read("src/app/data-settings/page.tsx");
  ok(group, /<JiraWriteBackPanel \/>/.test(ds) && /data-jira-write-log/.test(read("src/components/command-center/JiraWriteBackPanel.tsx")), "Data & Settings: allow-list, Flag, per-project transition, and the write history");
}
