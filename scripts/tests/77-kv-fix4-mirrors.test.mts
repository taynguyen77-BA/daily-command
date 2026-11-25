// V2.53 fix 4 — smaller items: the briefing mirror skips an unchanged payload (builtAt alone never counts as a change);
// the write-log list is already bounded; the health probe is memoized.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { briefingMirrorSignature, shouldPostBriefing } from "../../src/lib/command-center/briefing-mirror.ts";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv.ts";
import { createKvJiraWriteLogStore, JIRA_WRITE_LOG_MAX_ENTRIES } from "../../src/lib/command-center/kv/kv-stores.ts";

const G = "kv-fix4";
const prefs = { enabled: true, time: "08:30" } as never;
const snap = (builtAt: string, n = 2) => ({ builtAt, nba: Array.from({ length: n }, (_, i) => ({ key: `P-${i}`, headline: `P-${i} do it` })), slipHigh: [], awaiting: [] }) as never;
const links = { "P-0": { title: "t", url: "https://x/P-0" } };

const a = briefingMirrorSignature(prefs, snap("2026-11-25T10:00:00.000Z"), links);
const b = briefingMirrorSignature(prefs, snap("2026-11-25T10:05:00.000Z"), links);
ok(G, a === b, "only builtAt changed -> same signature");
ok(G, a !== briefingMirrorSignature(prefs, snap("2026-11-25T10:05:00.000Z", 3), links), "a new Next Best Action changes it");
ok(G, a !== briefingMirrorSignature({ enabled: false, time: "08:30" } as never, snap("2026-11-25T10:00:00.000Z"), links), "prefs change it");
ok(G, a !== briefingMirrorSignature(prefs, snap("2026-11-25T10:00:00.000Z"), { ...links, "P-1": { title: "u" } }), "links change it");
ok(G, shouldPostBriefing(null, a) === true && shouldPostBriefing(a, a) === false && shouldPostBriefing(a, "other") === true, "post only when the signature differs from the last mirrored one");

// write log: the UI asks for 50 and the store only reads that tail
{
  const raw = createInMemoryKv();
  const store = createKvJiraWriteLogStore(raw);
  for (let i = 0; i < 120; i++) await store.append({ at: new Date(2026, 0, 1, 0, i).toISOString(), issueKey: `P-${i}` } as never);
  ok(G, (await store.list(50)).length === 50, "list(50) returns 50 of 120");
  ok(G, JIRA_WRITE_LOG_MAX_ENTRIES === 1000, "retention is still 1000");
}
const writeRoute = fs.readFileSync("src/app/api/command-center/jira/write/route.ts", "utf8");
ok(G, !/\.list\((?!50\))/.test(writeRoute), "the write route never lists more than 50");

// wiring (static)
const card = fs.readFileSync("src/components/command-center/BriefingCard.tsx", "utf8");
ok(G, /shouldPostBriefing\(/.test(card) && /briefingMirrorSignature\(/.test(card), "BriefingCard skips an unchanged mirror");
const health = fs.readFileSync("src/app/api/command-center/health/route.ts", "utf8");
ok(G, /memoizeProbe\(/.test(health) && /KV_PROBE_TTL_MS = 30_000/.test(health), "the health KV probe is memoized (30 s per instance)");
const reminders = fs.readFileSync("src/lib/command-center/reminder-sync.ts", "utf8");
ok(G, /if \(sig === lastSig\) return;/.test(reminders), "the reminders mirror already skips an unchanged index");
