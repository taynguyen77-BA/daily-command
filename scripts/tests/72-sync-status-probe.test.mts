// V2.52.2 — the sync status check must not download the whole synced blob (it burned the KV bandwidth quota).
import fs from "node:fs";
import { ok } from "./harness.mts";
import { isStatusProbe, STATUS_PROBE_QUERY } from "../../src/lib/command-center/app-state.ts";

const G = "sync-status-probe";
ok(G, isStatusProbe(`http://x/api/command-center/state?${STATUS_PROBE_QUERY}`), "?probe=1 is a status probe");
ok(G, !isStatusProbe("http://x/api/command-center/state"), "plain GET still returns the blob");
ok(G, !isStatusProbe("http://x/api/command-center/state?probe=0"), "probe=0 is not a probe");
ok(G, !isStatusProbe("not a url"), "malformed URL is not a probe (never throws)");

const route = fs.readFileSync("src/app/api/command-center/state/route.ts", "utf8");
const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
ok(G, get.indexOf("isStatusProbe") > -1 && get.indexOf("isStatusProbe") < get.indexOf(".get()"), "GET answers a probe before reading KV");
const sync = fs.readFileSync("src/lib/command-center/app-state-sync.ts", "utf8");
const status = sync.slice(sync.indexOf("export async function checkAppStateSyncStatus"));
ok(G, /STATUS_PROBE_QUERY/.test(status.slice(0, 400)), "checkAppStateSyncStatus uses the probe");
