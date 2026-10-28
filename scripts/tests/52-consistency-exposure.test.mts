// C2 — consistency & exposure: R3 Release Health scoring model, R4 status endpoints, R5 bootstrap clause, R6 learning zone.
import fs from "node:fs";
import { selectAllReleaseHealth, selectReleaseHealth } from "../../src/lib/command-center/release-health";
import { scoreAllWorkItems } from "../../src/lib/command-center/scoring";
import { emptyData, type CommandCenterData, type WorkItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";

const today = "2026-10-27";
const mk = (i: number, priority: WorkItem["priority"]): WorkItem =>
  ({ id: `jira-R-${i}`, key: `R-${i}`, title: `t${i}`, projectId: "p", clientId: "c", type: "task", status: "In Progress", priority, createdDate: "2026-08-01", dueDate: "2026-10-28", businessImpact: 5, lastUpdated: "2026-10-10", blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 4, fixVersions: ["1.0"], fixVersion: "1.0", jiraPriorityName: priority === "P1" ? "Highest" : "Lowest", priorityKnown: true } as WorkItem);
const dataOf = (priority: WorkItem["priority"]): CommandCenterData => ({ ...emptyData(), workItems: Array.from({ length: 3 }, (_, i) => mk(i, priority)) });

{
  const group = "C2 R3 Release Health scoring model";
  const p1 = dataOf("P1");
  const p4 = dataOf("P4");
  const v2 = { model: "v2" as const };
  const c1v2 = selectReleaseHealth(p1, "1.0", today, undefined, v2).deliveryConfidence;
  const c4v2 = selectReleaseHealth(p4, "1.0", today, undefined, v2).deliveryConfidence;
  ok(group, c1v2 < c4v2, `v2: a P1-heavy open set has lower deliveryConfidence than a P4-heavy one (${c1v2} < ${c4v2})`);
  const c1v1 = selectReleaseHealth(p1, "1.0", today).deliveryConfidence;
  const c4v1 = selectReleaseHealth(p4, "1.0", today).deliveryConfidence;
  // v1 scores ignore Jira priority (the old blind spot): the per-item classifications are identical for both sets.
  const cls = (d: CommandCenterData, model: "v1" | "v2") => scoreAllWorkItems(d, today, undefined, undefined, { model }).map((r) => r.classification).join(",");
  ok(group, cls(p1, "v1") === cls(p4, "v1") && cls(p1, "v2") !== cls(p4, "v2"), `v1 classifies a P1 set and a P4 set identically (${cls(p1, "v1")}); v2 tells them apart (${cls(p1, "v2")} vs ${cls(p4, "v2")})`);
  ok(group, c4v1 !== c4v2, `switching the model changes Release Health (P4 set: v1 ${c4v1} -> v2 ${c4v2})`);
  ok(group, selectReleaseHealth(p1, "1.0", today, undefined, { model: "v1" }).deliveryConfidence === c1v1, "an explicit v1 equals the omitted default (existing outputs unchanged)");
  const all = selectAllReleaseHealth(p1, today, undefined, v2);
  ok(group, all.length === 1 && all[0].deliveryConfidence === c1v2, "selectAllReleaseHealth threads the options too");
}

{
  const group = "C2 R3 every caller passes the scoring options";
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const callers: [string, RegExp][] = [
    ["src/components/command-center/ReleaseHealthPanel.tsx", /selectAllReleaseHealth\(data, today, workRelevanceIndex, scoring\)/],
    ["src/components/command-center/CommandBar.tsx", /selectReleaseHealth\(viewData, version, today, workRelevanceIndex, scoring\)/],
    ["src/lib/command-center/proactive.ts", /selectAllReleaseHealth\(data, today, workRelevanceIndex, scoring\)/],
    ["src/lib/command-center/store.ts", /selectAllReleaseHealth\(dataAfter, today, workRelevanceIndex, this\.scoringOptions\(\)\)/],
    ["src/lib/command-center/release-drift.ts", /selectReleaseHealth\(previousData, health\.fixVersion, today, workRelevanceIndex, scoring\)/],
    ["src/lib/command-center/communicate.ts", /selectReleaseHealth\(data, sourceRef\.fixVersion, today, workRelevanceIndex, scoring\)/],
    ["src/lib/command-center/query-router.ts", /selectReleaseHealth\(data, route\.target, today, workRelevanceIndex, scoring\)/],
  ];
  for (const [file, re] of callers) ok(group, re.test(read(file)), `${file} passes the scoring options`);
  ok(group, /<ReleaseHealthPanel[^>]*scoring=\{scoring\}/.test(read("src/app/page.tsx")), "the dashboard hands its scoring options to the panel");
}

{
  const group = "C2 R4 status endpoints";
  const { GET: notifyGET } = await import("../../src/app/api/command-center/notify/route");
  const { memoizeProbe, MINIMAL_HEALTH_BODY, minimalNotifyBody } = await import("../../src/lib/command-center/status-access");
  const { selectServerCheck } = await import("../../src/lib/command-center/health-client");
  const keep = { secret: process.env.APP_STATE_SECRET, cron: process.env.CRON_SECRET, hook: process.env.SLACK_WEBHOOK_URL, auth: process.env.AUTH_ENABLED, label: process.env.SLACK_CHANNEL_LABEL };
  process.env.APP_STATE_SECRET = "pair-secret-xyz";
  delete process.env.CRON_SECRET;
  delete process.env.AUTH_ENABLED;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/services/secret";
  process.env.SLACK_CHANNEL_LABEL = "#alerts";
  try {
    const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/command-center/notify", { headers });
    const anon = await notifyGET(req());
    const anonBody = JSON.stringify(await anon.json());
    ok(group, anon.status === 200 && anonBody === JSON.stringify(minimalNotifyBody(true)), `notify, unauthenticated: only { configured } (${anonBody})`);
    ok(group, !/prefs|mutedProjects|channelLabel|serverSideNotifyActive|hooks\.slack|alerts/.test(anonBody), "the unauthenticated notify body has no prefs, muted project keys, channel label or cron state");
    const wrong = JSON.stringify(await (await notifyGET(req({ Authorization: "Bearer wrong" }))).json());
    ok(group, wrong === anonBody, "a wrong bearer is treated as unauthenticated");
    const paired = (await (await notifyGET(req({ Authorization: "Bearer pair-secret-xyz" }))).json()) as Record<string, unknown>;
    ok(group, paired.configured === true && paired.channelLabel === "#alerts" && "serverSideNotifyActive" in paired && "prefs" in paired, "notify, paired: the full body is unchanged");
    ok(group, !JSON.stringify(paired).includes("hooks.slack.example"), "…and still never carries the webhook URL");

    // sign-in on but not configured -> 503 comes from principalError (server-only module, so asserted on the source);
    // with sign-in OFF and no secret at all, checkSyncRequestAuth says 503 and the caller is "unpaired" (minimal body).
    const { checkSyncRequestAuth } = await import("../../src/lib/command-center/jira/sync-auth");
    ok(group, checkSyncRequestAuth("Bearer x", undefined, undefined).ok === false && (checkSyncRequestAuth("Bearer x", undefined, undefined) as { status: number }).status === 503, "no secret configured -> 503 from the auth check (an unpaired caller)");
    const noSecret = JSON.stringify(await (await (async () => { delete process.env.APP_STATE_SECRET; return notifyGET(req({ Authorization: "Bearer pair-secret-xyz" })); })()).json());
    process.env.APP_STATE_SECRET = "pair-secret-xyz";
    ok(group, noSecret === JSON.stringify(minimalNotifyBody(true)), "with no secret configured nobody is paired: minimal body");
    const routeSrc = fs.readFileSync("src/app/api/command-center/notify/route.ts", "utf8") + fs.readFileSync("src/app/api/command-center/health/route.ts", "utf8");
    ok(group, (routeSrc.match(/principalError\(p\)/g) ?? []).length >= 2, "sign-in on: both routes still answer misconfigured (503) / unauthenticated (401) through principalError");

    // health: minimal body, memoized KV probe
    const body = JSON.stringify(MINIMAL_HEALTH_BODY);
    ok(group, body === '{"ok":true}' && !/version|kv|jira|slack|cron|prefs/.test(body), "health, unauthenticated: only { ok: true } — no version, services, cron or prefs");
    ok(group, selectServerCheck(MINIMAL_HEALTH_BODY as never) === null, "the client treats the minimal body as 'not in use' instead of crashing");
    let calls = 0;
    let t = 1_000;
    const probe = memoizeProbe(async () => { calls++; return true; }, 30_000, () => t);
    for (let i = 0; i < 20; i++) { t += 100; await probe(); }
    ok(group, calls === 1, `KV probe called once for 20 requests inside 30 s (${calls})`);
    t += 31_000; await probe();
    ok(group, calls === 2, "…and again after the 30 s window");

    const src = fs.readFileSync("src/app/api/command-center/health/route.ts", "utf8");
    ok(group, /checkSyncRequestAuth\(/.test(src) && /MINIMAL_HEALTH_BODY/.test(src) && /memoizeProbe\(/.test(src), "the health route gates on the pairing secret and memoizes the probe");
    const client = fs.readFileSync("src/lib/command-center/health-client.ts", "utf8") + fs.readFileSync("src/lib/command-center/notify-client.ts", "utf8");
    ok(group, (client.match(/pairedAuthHeader\(\)/g) ?? []).length >= 3, "both clients send the pairing header they already use elsewhere");
  } finally {
    for (const [k, v] of Object.entries({ APP_STATE_SECRET: keep.secret, CRON_SECRET: keep.cron, SLACK_WEBHOOK_URL: keep.hook, AUTH_ENABLED: keep.auth, SLACK_CHANNEL_LABEL: keep.label })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

{
  const group = "C2 R5 bootstrap clause survives a truncated first sync";
  const { buildIssuesJql } = await import("../../src/lib/command-center/jira/http");
  const { commandCenterStore, parseStoredState } = await import("../../src/lib/command-center/store");
  const cursor = "2026-10-20 10:00";
  ok(group, buildIssuesJql({ sinceIso: cursor, bootstrapDays: 90 }) === 'updated >= "2026-10-20 10:00" order by updated asc', "default: bootstrapDays is still ignored once there is a cursor (existing JQL byte-identical)");
  ok(group, buildIssuesJql({ sinceIso: cursor, bootstrapDays: 90, keepBootstrap: true }) === 'updated >= "2026-10-20 10:00" AND (statusCategory != Done OR updated >= -90d) order by updated asc', "while the first sync is unfinished the resume JQL carries the cursor AND the bootstrap window");
  ok(group, buildIssuesJql({ bootstrapDays: 90, keepBootstrap: true }) === "(statusCategory != Done OR updated >= -90d) order by updated asc", "no cursor: unchanged (a single bootstrap clause)");

  commandCenterStore.resetAll();
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const respond = (extra: Record<string, unknown>) => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes("/api/command-center/jira/sync")) {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { clients: [], projects: [], workItems: [], dependencies: [] }, recordsFetched: 2000, warnings: [], ...extra }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as typeof fetch;
  };
  try {
    respond({ truncated: true, resumeSinceIso: "2026-10-01T00:00:00.000Z", syncedAt: "2026-10-27T00:00:00.000Z" });
    await commandCenterStore.syncJira({ full: true });
    ok(group, commandCenterStore.getSnapshot().jiraSync.initialSyncComplete === false, "a truncated FIRST sync marks initialSyncComplete=false");
    ok(group, bodies[0].bootstrapPending === undefined, "the first request carries no bootstrapPending (no cursor yet)");
    respond({ truncated: true, resumeSinceIso: "2026-10-10T00:00:00.000Z", syncedAt: "2026-10-27T00:05:00.000Z" });
    await commandCenterStore.syncJira({});
    ok(group, bodies[1].bootstrapPending === true && typeof bodies[1].sinceIso === "string", "the resume request tells the server to keep the bootstrap window");
    ok(group, commandCenterStore.getSnapshot().jiraSync.initialSyncComplete === false, "…and a second truncated sync leaves it false");
    respond({ truncated: false, syncedAt: "2026-10-27T00:10:00.000Z" });
    await commandCenterStore.syncJira({});
    ok(group, bodies[2].bootstrapPending === true && commandCenterStore.getSnapshot().jiraSync.initialSyncComplete === true, "the first sync that is not truncated flips it to true");
    respond({ truncated: false, syncedAt: "2026-10-27T00:15:00.000Z" });
    await commandCenterStore.syncJira({});
    ok(group, bodies[3].bootstrapPending === undefined, "afterwards incremental syncs are exactly as before (no bootstrapPending)");
  } finally {
    globalThis.fetch = originalFetch;
    commandCenterStore.resetAll();
  }

  // an old persisted blob (no flag) loads and behaves as complete
  const old = parseStoredState(JSON.stringify({ version: 1, jiraSync: { lastSyncStatus: "success", lastSyncCompletedAt: "2026-10-01T00:00:00.000Z" } }));
  ok(group, !!old && old.jiraSync.initialSyncComplete === undefined, "a stored blob without initialSyncComplete loads (undefined = complete: nothing changes for existing installs)");
  const flagged = parseStoredState(JSON.stringify({ version: 1, jiraSync: { lastSyncStatus: "partial", initialSyncComplete: false } }));
  ok(group, flagged?.jiraSync.initialSyncComplete === false, "the flag round-trips through parseStoredState");
}

{
  const group = "C2 R6 learning compares dates in one zone";
  const { collectAppearances, localDateAtOffset } = await import("../../src/lib/command-center/learned-adjustments");
  const base = {
    today: "2026-10-30",
    planItems: [{ ticketKey: "AB-1", plannedDate: "2026-10-27", sourceType: "jira-ticket", sourceId: "AB-1" } as never],
    workItems: [{ key: "AB-1", projectId: "p", type: "task", priority: "P2" as const }],
  };
  // 00:30 on the 27th in UTC+7 is 17:30Z on the 26th: the user acted on the planned day, the UTC string says the day BEFORE.
  const ticketWorkStates = { "AB-1": { history: [{ at: "2026-10-26T17:30:00.000Z", from: "TODO", to: "IN_PROGRESS" }] } } as never;
  const utc = collectAppearances({ ...base, ticketWorkStates });
  ok(group, utc[0].outcome === "ignored", "without a zone the UTC date (26th) is before the planned day: the action is missed (the old behaviour)");
  const local = collectAppearances({ ...base, ticketWorkStates, localDateOf: (iso) => localDateAtOffset(iso, 420) });
  ok(group, local[0].outcome === "acted", "with the user's offset (UTC+7) an action at 00:30 local lands in the planned day's window");
  // late evening UTC+7 on the last window day must not spill past the window end
  const late = collectAppearances({ ...base, today: "2026-11-05", ticketWorkStates: { "AB-1": { history: [{ at: "2026-10-29T18:00:00.000Z", from: "TODO", to: "DONE" }] } } as never, localDateOf: (iso) => localDateAtOffset(iso, 420) });
  ok(group, late[0].outcome === "ignored", "01:00 local on Oct 30 (after the 2-business-day window ending Oct 29) is outside the window");
  ok(group, localDateAtOffset("2026-10-26T17:30:00.000Z", 420) === "2026-10-27" && localDateAtOffset("2026-10-27T01:00:00.000Z", -300) === "2026-10-26", "localDateAtOffset");
  const src = fs.readFileSync("src/lib/command-center/scoring-context.ts", "utf8");
  ok(group, /localDateOf: browserLocalDate/.test(src), "the app passes the browser's local date function (plan dates are browser-local)");
}

{
  const group = "C2 R3 scoring callers (grep proof)";
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
  const offenders: string[] = [];
  for (const f of walk("src")) {
    if (/\/scoring(-v2)?\.ts$/.test(f)) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/\b(scoreAllWorkItems|scoreWorkItem)\(/.test(line) && !/^\s*(import|\/\/|\*)/.test(line) && !/scoring\)|scoring\s*$|\/\/ v1 on purpose/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  ok(group, offenders.length === 0, `every scoreAllWorkItems / scoreWorkItem caller outside tests passes the scoring options (offenders: ${offenders.join(", ") || "none"}); no deliberate v1 use remains`);
}
