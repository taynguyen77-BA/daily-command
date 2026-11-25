// V2.53 — usage: KV_METRICS=1 npm run dev > kv.log   (or copy Vercel function logs to a file)
//        npx tsx scripts/kv-metrics-report.mts kv.log      (or: ... | npx tsx scripts/kv-metrics-report.mts)
import fs from "node:fs";
import { aggregateKvMetrics } from "../src/lib/command-center/kv/kv-metrics.ts";

const file = process.argv[2];
const text = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
const rows = aggregateKvMetrics(text.split("\n"));
if (rows.length === 0) {
  console.log("No [kv-metrics] lines found. Run the app with KV_METRICS=1 first.");
  process.exit(0);
}
const fmt = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
console.log(["key base".padEnd(48), "calls".padStart(7), "read".padStart(10), "written".padStart(10), "avg".padStart(10), "max".padStart(10), "% total".padStart(8)].join(" "));
for (const r of rows) console.log([r.keyBase.padEnd(48), String(r.calls).padStart(7), fmt(r.bytesRead).padStart(10), fmt(r.bytesWritten).padStart(10), fmt(r.avgBytes).padStart(10), fmt(r.maxBytes).padStart(10), `${r.pct}%`.padStart(8)].join(" "));
