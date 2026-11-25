// V2.53 phase 2 — before/after on the same in-memory KV (scripts/kv-bandwidth-sim.mts) and the backward-compat contract.
import { ok } from "./harness.mts";
import { runSim } from "../kv-bandwidth-sim.mts";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv.ts";
import { SERVER_REPORTS_KEY, createKvServerReportStore } from "../../src/lib/command-center/kv/kv-stores.ts";

const G = "kv-bandwidth-sim";
const { rows, firstTickAfter } = await runSim();
const [tick, focus, edits] = rows;
ok(G, tick.bytesAfter < tick.bytesBefore / 5, `steady-state cron tick: ${tick.bytesBefore} B -> ${tick.bytesAfter} B (>5x less)`);
ok(G, tick.callsAfter <= tick.callsBefore, `...with no more KV calls (${tick.callsBefore} -> ${tick.callsAfter})`);
ok(G, focus.bytesAfter < focus.bytesBefore / 50 && focus.callsAfter < focus.callsBefore, `20 focus events: ${focus.bytesBefore} B -> ${focus.bytesAfter} B, ${focus.callsBefore} -> ${focus.callsAfter} calls`);
ok(G, edits.bytesAfter <= edits.bytesBefore, `10 state edits never cost more bytes (${edits.bytesBefore} -> ${edits.bytesAfter}; the push itself is still the whole blob)`);
ok(G, firstTickAfter.bytes > 0 && firstTickAfter.bytes < 10 * 1024 * 1024, `the one-time legacy migration is bounded (${firstTickAfter.bytes} B for 3 members)`);

// legacy data keeps its client-facing shape: the same reports object comes back
const kv = createInMemoryKv();
const legacy = { baseline: { assignedOpenKeys: [], assignedAllKeys: [], seenMentionCommentIds: [], lastRunIso: "2026-10-06T10:00:00.000Z" }, reports: { "2026-10-05": { date: "2026-10-05", generatedAt: "x", newAssigned: [], newMentions: [], closedInJira: [], openAssigned: [] }, "2026-10-06": { date: "2026-10-06", generatedAt: "y", newAssigned: [], newMentions: [], closedInJira: [], openAssigned: [] } } };
await kv.set(SERVER_REPORTS_KEY, legacy);
const store = createKvServerReportStore(kv);
ok(G, JSON.stringify(await store.getSince!(undefined)) === JSON.stringify(legacy.reports), "GET reports/server without ?since= returns exactly the legacy reports object");
await store.putBaseline!({ ...legacy.baseline, lastRunIso: "2026-10-07T10:00:00.000Z" });
ok(G, JSON.stringify(await store.getSince!(undefined)) === JSON.stringify(legacy.reports) && (await store.get())!.baseline!.lastRunIso === "2026-10-07T10:00:00.000Z", "after lazy migration the same reports come back and the new baseline is stored");
