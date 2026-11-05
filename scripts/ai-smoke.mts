// D3 — `npm run smoke:ai`: runs the AI self-test fixtures against the REAL Anthropic API with ANTHROPIC_API_KEY, prints the table,
// writes ./ai-smoke-report.json (gitignored) and exits 1 on any FAIL. NOT part of `npm test` / CI (it spends tokens).
//   ANTHROPIC_API_KEY=sk-ant-… npm run smoke:ai            (quick: 5 core tasks)
//   ANTHROPIC_API_KEY=sk-ant-… npm run smoke:ai -- --full
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { runSelfTest, formatSelfTestTable } from "../src/lib/command-center/ai/selftest";
import { type ModelCallParams, type ModelCallResult } from "../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger } from "../src/lib/command-center/ai/usage-ledger";
import { redactSecrets } from "../src/lib/command-center/ai/provider-config";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run the live AI smoke test.");
  process.exit(2);
}
const client = new Anthropic({ apiKey, timeout: 55_000 });
const callModel = async (p: ModelCallParams): Promise<ModelCallResult> => {
  const r = await client.beta.messages.create({ model: p.model, max_tokens: p.maxTokens, system: [{ type: "text", text: p.system }], messages: p.messages, ...(p.useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}) });
  const t = r.content.find((b) => b.type === "text");
  return { stopReason: r.stop_reason, text: t && t.type === "text" ? t.text : undefined, usage: { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0 } };
};
const mode = process.argv.includes("--full") ? "full" : "quick";
const report = await runSelfTest({
  mode,
  deps: { env: { ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL, ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST, ANTHROPIC_MODEL_DEEP: process.env.ANTHROPIC_MODEL_DEEP }, callModel, ledger: new MemoryUsageLedger(), now: () => new Date() },
  maxTokens: Number(process.env.AI_SELFTEST_MAX_TOKENS) || undefined,
  onRow: (r) => console.log(`${r.outcome.padEnd(7)} ${r.label}${r.note ? ` — ${r.note}` : ""}`),
});
console.log("\n" + redactSecrets(formatSelfTestTable(report)));
fs.writeFileSync("ai-smoke-report.json", redactSecrets(JSON.stringify(report, null, 2)));
process.exit(report.rows.some((r) => r.outcome === "FAIL") ? 1 : 0);
