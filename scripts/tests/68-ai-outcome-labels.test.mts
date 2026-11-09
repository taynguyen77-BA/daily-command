// V2.51 A2 — every AI feature is labelled from its own call's outcome, never from the shared provider.mode.
import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";
import { ClaudeProvider, clearAiBudgetStatus } from "../../src/lib/command-center/ai/claude-provider";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { createOutcomeScope, runScoped } from "../../src/lib/command-center/ai/outcome-scope";
import { explainAiFailure, type AiFailureReason } from "../../src/lib/command-center/ai/outcome";
import { generateWeeklyInsights } from "../../src/lib/command-center/ai/weekly-insights";
import { extractMeetingReview } from "../../src/lib/command-center/ai/meeting-actions";
import { runReleaseBrief } from "../../src/lib/command-center/ai/release-brief";
import { rewriteReportFlow } from "../../src/lib/command-center/ai/report-rewrite";
import { RedactionSession } from "../../src/lib/command-center/ai/redaction";
import { SELFTEST_FIXTURES } from "../../src/lib/command-center/ai/selftest-fixtures";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData } from "../../src/lib/command-center/types";

const original = globalThis.fetch;
type Fake = (init: RequestInit, task: string) => Response | Promise<Response>;
const withFetch = async <T,>(fake: Fake, fn: () => Promise<T>): Promise<T> => {
  clearAiBudgetStatus();
  globalThis.fetch = (async (_u: string, init?: RequestInit) => (!init || !init.method || init.method === "GET" ? new Response(JSON.stringify({ available: true }), { status: 200 }) : fake(init, (JSON.parse(String(init.body)) as { task: string }).task))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const insights = { observations: [{ text: "Blocked tickets grew.", evidence: ["fact a"] }], suggestions: ["Review blockers early."] };
const guidance = { summary: "Start with SELF-1.", topFocus: [], watch: [], recommendation: "Nudge.", evidenceReferences: [], confidence: 0.6 };
const FAIL: { reason: AiFailureReason; status: number; kind?: string }[] = [
  { reason: "budget", status: 429, kind: "budget-exhausted" },
  { reason: "grounding", status: 422, kind: "grounding-rejected" },
  { reason: "truncated", status: 502, kind: "truncated" },
];

// ---- the guard: nothing outside the provider layer reads provider.mode ----
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const READS_PROVIDER_MODE = /\b(?:provider|getAIProvider\(\)|aiProvider|p)\.mode\b/;
export const findProviderModeReads = (files: { name: string; text: string }[], allow: RegExp): string[] => files.filter((f) => !allow.test(f.name) && READS_PROVIDER_MODE.test(stripComments(f.text))).map((f) => f.name);
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const ALLOW = /(claude-provider|ai\/provider|ai\/index|outcome-scope)\.ts$|AiReadinessPanel|SetupHealth/;

{
  const group = "V2.51 A2 guard";
  const files = [...walk("src/components"), ...walk("src/lib/command-center/ai")].map((name) => ({ name, text: fs.readFileSync(name, "utf8") }));
  const bad = findProviderModeReads(files, ALLOW);
  ok(group, bad.length === 0, `no component or AI module outside the provider layer reads provider.mode${bad.length ? `: ${bad.join(", ")}` : ""}`);
  const synthetic = [{ name: "src/components/x/New.tsx", text: "const label = getAIProvider().mode === 'claude' ? 'AI' : 'No';" }, { name: "src/components/x/Ok.tsx", text: "// provider.mode is deprecated\nconst x = 1;" }, { name: "src/lib/command-center/ai/claude-provider.ts", text: "get mode() { return provider.mode }" }];
  ok(group, findProviderModeReads(synthetic, ALLOW).join() === "src/components/x/New.tsx", "the scan flags a new provider.mode label read, ignores comments and the allow-list");
  for (const f of ["WeeklyInsights", "TicketBrief", "SmartTriagePanel", "MentionReplyDrafter", "AiFollowUpDrafter", "BaRequirementCheck", "ReleaseGoNoGo", "MeetingNotesActions", "TicketAiPanel"]) {
    ok(group, /AiFailureNote/.test(fs.readFileSync(`src/components/command-center/${f}.tsx`, "utf8")), `${f} shows the failure reason when AI was requested and failed`);
  }
  for (const f of ["HealthTrend", "RiskCard", "ProjectStory", "DecisionCard", "AskClaudeAbout", "ArtifactEditor", "TakeActionPanel"]) {
    ok(group, /createOutcomeScope|runScoped/.test(fs.readFileSync(`src/components/command-center/${f}.tsx`, "utf8")), `${f} derives its label from its own call`);
  }
}

{
  const group = "V2.51 A2 scope semantics";
  const mock = await runScoped(new MockAIProvider(), (p) => p.explainChanges({ id: "c", entityType: "WorkItem", entityId: "w", entityLabel: "PAY-1", field: "status", before: "a", after: "b", detectedAt: "2026-11-09", impact: "x" }));
  ok(group, !mock.ai && mock.mode === "mock" && mock.failure?.reason === "unavailable", "a provider without runTask (the mock) is classified unavailable");
  const fakeClaude = await runScoped({ mode: "claude" as const, ping: async () => 1 }, (p) => p.ping());
  ok(group, fakeClaude.ai && fakeClaude.mode === "claude", "a test fake declaring mode 'claude' without runTask is classified AI");
  const none = createOutcomeScope();
  ok(group, !none.called && !none.ai && none.mode === "mock" && none.failure === undefined, "a run that made no call (cache hit / short-circuit) has no AI label and no failure");
  const st = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [], eodHistory: [{ date: "2026-11-01", summary: "old" }] }));
  ok(group, st.eodHistory[0].summary === "old" && st.eodHistory[0].mode === undefined, "an old end-of-day entry without a mode still loads");
}

{
  const group = "V2.51 A2 failure per feature";
  for (const f of FAIL) {
    const server = () => json({ ok: false, error: "x", errorKind: f.kind, usage: { cap: 100, remainingToday: 50 } }, f.status);
    const wi = await withFetch(server, () => generateWeeklyInsights({ facts: ["a fact"], weekStart: "2026-11-02", weekEnd: "2026-11-08", customTerms: [], provider: new ClaudeProvider() }));
    const mockWi = await new MockAIProvider().weeklyInsights({ weekStart: "2026-11-02", weekEnd: "2026-11-08", facts: ["a fact"] });
    ok(group, wi.mode === "mock" && wi.failure?.reason === f.reason && JSON.stringify(wi.insights) === JSON.stringify(mockWi), `weekly insights (${f.reason}): calculated insights + the matching reason`);
    const mr = await withFetch(server, () => extractMeetingReview({ notes: "Decision: ship", today: "2026-11-09", customTerms: [], knownKeys: new Set(), provider: new ClaudeProvider() }));
    ok(group, mr.mode === "mock" && mr.failure?.reason === f.reason && mr.review.decisions.length >= 0, `meeting notes (${f.reason}): deterministic review + reason`);
    const rb = await withFetch(server, () => runReleaseBrief(SELFTEST_FIXTURES.find((x) => x.id === "release-go-no-go")!.input as never, new RedactionSession([]), new ClaudeProvider()));
    ok(group, !rb.usedAi && rb.failure?.reason === f.reason && /deterministic/i.test(rb.notice ?? ""), `release brief (${f.reason}): deterministic brief + reason`);
    const rw = await withFetch(server, () => rewriteReportFlow({ source: "Daily Report\n- ABC-1 Fix", audience: "standup", customTerms: [], provider: new ClaudeProvider() }));
    ok(group, !rw.usedAi && rw.notice!.includes(explainAiFailure(f.reason).title), `report rewrite (${f.reason}): deterministic report + the matching text`);
  }
  const good = await withFetch(() => json({ ok: true, data: insights, usage: { cap: 100, remainingToday: 50 } }), () => generateWeeklyInsights({ facts: ["fact a"], weekStart: "2026-11-02", weekEnd: "2026-11-08", customTerms: [], provider: new ClaudeProvider() }));
  ok(group, good.mode === "claude" && !good.failure && good.insights.observations[0].text === insights.observations[0].text, "a successful call is labelled AI and carries no failure");
  const unavailable = await (async () => {
    globalThis.fetch = (async () => json({ available: false })) as typeof fetch;
    try {
      return await generateWeeklyInsights({ facts: ["a"], weekStart: "2026-11-02", weekEnd: "2026-11-08", customTerms: [], provider: new ClaudeProvider() });
    } finally {
      globalThis.fetch = original;
    }
  })();
  ok(group, unavailable.mode === "mock" && unavailable.failure?.reason === "unavailable", "AI not set up -> unavailable");
}

{
  const group = "V2.51 A2 overlapping calls";
  // One shared provider. B (slow, succeeds) starts FIRST; A (fast, fails) starts second and finishes first; B finishes last.
  // The shared provider.mode ends as "claude" (B wrote it last) although A failed — the old label would have said AI for A.
  let releaseB: () => void = () => {};
  const gateB = new Promise<void>((r) => { releaseB = r; });
  const provider = new ClaudeProvider();
  const result = await withFetch(async (_init, task) => {
    if (task === "weeklyInsights") {
      await gateB;
      return json({ ok: true, data: insights, usage: { cap: 100, remainingToday: 50 } });
    }
    return json({ ok: false, errorKind: "provider-error" }, 502);
  }, async () => {
    const b = runScoped(provider, (p) => p.weeklyInsights({ weekStart: "2026-11-02", weekEnd: "2026-11-08", facts: ["fact a"] }));
    await new Promise((r) => setTimeout(r, 10));
    const a = await runScoped(provider, (p) => p.generateDailyGuidance(["x"], [], [], [], ["y"]));
    releaseB();
    return { a, b: await b };
  });
  ok(group, result.b.ai && result.b.mode === "claude" && !result.b.failure, "the slow successful call is labelled AI");
  ok(group, !result.a.ai && result.a.mode === "mock" && result.a.failure?.reason === "provider-error", "the fast failing call is labelled calculated with its own reason, whatever finished last");
  ok(group, provider.mode === "claude", "(the shared provider.mode would have said 'claude' for BOTH — the failure this migration removes)");
  const both = await withFetch(() => json({ ok: true, data: guidance, usage: { cap: 100, remainingToday: 50 } }), async () => {
    const [x, y] = await Promise.all([runScoped(provider, (p) => p.generateDailyGuidance(["x"], [], [], [], ["y"])), runScoped(provider, (p) => p.generateDailyGuidance(["z"], [], [], [], ["w"]))]);
    return [x.ai, y.ai];
  });
  ok(group, both.every(Boolean), "two concurrent successes are both AI");
}
