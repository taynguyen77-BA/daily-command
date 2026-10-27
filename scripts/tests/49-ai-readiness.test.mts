// P3.7 — AI readiness matrix, shared tooltip hook, presets, model default.
import fs from "node:fs";
import path from "node:path";
import { AI_FEATURES, AI_PRESETS, aiReadiness, aiReadinessMatrix, applyPreset, presetDiff, undoPreset, READY_TEXT, type AiFeatureId, type AiReadinessContext } from "../../src/lib/command-center/ai/readiness";
import { DEFAULT_FEATURE_TOGGLES } from "../../src/lib/command-center/types";
import { DEFAULT_AI_MODEL_FAST, isAlwaysThinkingModel, resolveAiModel, aiModelStatus } from "../../src/lib/command-center/ai/model-config";
import { v226Store } from "./helpers.mts";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const allOn = Object.fromEntries(AI_FEATURES.map((f) => [f.id, true])) as Record<AiFeatureId, boolean>;
const ctx = (over: Partial<AiReadinessContext> = {}): AiReadinessContext => ({ features: allOn, ai: { available: true, aiAllowedProjectKeys: null }, usage: { remainingToday: 1000 }, allowedProjectKeys: ["ABC", "XYZ"], projectKeys: ["ABC", "XYZ", "QQQ"], ...over });
const content = AI_FEATURES.filter((f) => f.ticketContent).map((f) => f.id);
const other = AI_FEATURES.filter((f) => !f.ticketContent).map((f) => f.id);

{
  const group = "P3.7 Readiness states";
  ok(group, AI_FEATURES.length === 12 && Object.keys(DEFAULT_FEATURE_TOGGLES).filter((k) => AI_FEATURES.some((f) => f.id === k)).length === 12 && AI_FEATURES.every((f) => DEFAULT_FEATURE_TOGGLES[f.id] === false), "12 AI features, all of them real toggles that default OFF");
  for (const f of AI_FEATURES) {
    const r = aiReadiness(f.id, ctx());
    ok(group, r.state === "READY" && r.nextStep === READY_TEXT && r.feature === f.id, `${f.id}: everything in place -> READY`);
  }
  const off = aiReadiness("ticketBrief", ctx({ features: { ...allOn, ticketBrief: false } }));
  ok(group, off.state === "OFF" && /Features/.test(off.nextStep) && off.nextStep.includes("Ticket brief"), "OFF names the switch");
  ok(group, aiReadiness("weeklyInsights", ctx({ ai: { available: false } })).state === "NEEDS_KEY" && /ANTHROPIC_API_KEY/.test(aiReadiness("weeklyInsights", ctx({ ai: { available: false } })).nextStep) && aiReadiness("weeklyInsights", ctx({ ai: null })).state === "READY", "NEEDS_KEY when the server says no key; while the status is unknown nothing is claimed");
  const noList = aiReadiness("smartTriage", ctx({ allowedProjectKeys: [] }));
  ok(group, noList.state === "NEEDS_ALLOWLIST" && /AI data protection/.test(noList.nextStep) && noList.projects.allowed === 0 && noList.projects.total === 3, "NEEDS_ALLOWLIST for a ticket-content feature with an empty allow-list");
  ok(group, aiReadiness("weeklyInsights", ctx({ allowedProjectKeys: [] })).state === "READY", "…but features that do not send ticket content are not held up by the allow-list");
  const blocked = aiReadiness("ticketAi", ctx({ ai: { available: true, aiAllowedProjectKeys: ["QQQ"] } }));
  ok(group, blocked.state === "SERVER_POLICY_BLOCKED" && blocked.nextStep.includes("AI_ALLOWED_PROJECT_KEYS") && blocked.nextStep.includes("QQQ") && blocked.projects.allowed === 0, "SERVER_POLICY_BLOCKED: the server's list shares no project with yours");
  ok(group, aiReadiness("ticketAi", ctx({ ai: { available: true, aiAllowedProjectKeys: ["ABC"] } })).state === "READY" && aiReadiness("ticketAi", ctx({ ai: { available: true, aiAllowedProjectKeys: ["ABC"] } })).projects.allowed === 1, "an overlapping server list is fine; projects.allowed counts the intersection");
  ok(group, aiReadiness("ticketAi", ctx({ ai: { available: true, aiAllowedProjectKeys: [] } })).state === "SERVER_POLICY_BLOCKED", "a server list that is set but empty allows nothing");
  const cap = aiReadiness("nlCommands", ctx({ usage: { remainingToday: 0 } }));
  ok(group, cap.state === "CAP_REACHED" && /00:00 UTC/.test(cap.nextStep) && aiReadiness("nlCommands", ctx({ usage: null })).state === "READY", "CAP_REACHED at zero tokens left; unknown usage is not a block");
  ok(group, aiReadiness("releaseGoNoGo", ctx()).projects.allowed === 3 && aiReadiness("releaseGoNoGo", ctx()).projects.total === 3, "unrestricted features report all projects");
  ok(group, aiReadiness("ticketBrief", ctx({ allowedProjectKeys: ["abc"], projectKeys: ["abc", "ABC"] })).projects.total === 1, "project keys are compared case-insensitively and counted once");
}

{
  const group = "P3.7 Precedence";
  const all = (over: Partial<AiReadinessContext>) => aiReadiness("ticketBrief", ctx(over));
  const broken = { features: { ...allOn, ticketBrief: false }, ai: { available: false, aiAllowedProjectKeys: ["QQQ"] }, usage: { remainingToday: 0 }, allowedProjectKeys: [] as string[] };
  ok(group, all(broken).state === "OFF", "OFF beats everything");
  ok(group, all({ ...broken, features: allOn }).state === "NEEDS_KEY", "…then NEEDS_KEY beats the allow-list, the server policy and the cap");
  ok(group, all({ ...broken, features: allOn, ai: { available: true, aiAllowedProjectKeys: ["QQQ"] } }).state === "NEEDS_ALLOWLIST", "…then NEEDS_ALLOWLIST beats the server policy and the cap");
  ok(group, all({ ...broken, features: allOn, ai: { available: true, aiAllowedProjectKeys: ["QQQ"] }, allowedProjectKeys: ["ABC"] }).state === "SERVER_POLICY_BLOCKED", "…then SERVER_POLICY_BLOCKED beats the cap");
  ok(group, all({ ...broken, features: allOn, ai: { available: true, aiAllowedProjectKeys: null }, allowedProjectKeys: ["ABC"] }).state === "CAP_REACHED", "…and CAP_REACHED is the last blocker");
  // ticket-scoped (the buttons on a ticket)
  const scoped = (key: string) => aiReadiness("ticketBrief", ctx({ projectKey: key }));
  ok(group, scoped("ABC").state === "READY" && scoped("ZZZ").state === "NEEDS_ALLOWLIST" && scoped("ZZZ").nextStep.includes("ZZZ") && aiReadiness("ticketBrief", ctx({ projectKey: "abc", ai: { available: true, aiAllowedProjectKeys: ["XYZ"] } })).state === "SERVER_POLICY_BLOCKED", "a ticket button checks that ticket's project: allowed, not on my list, or blocked by the server");
  const m = aiReadinessMatrix(ctx({ allowedProjectKeys: [] }));
  ok(group, m.length === 12 && m.filter((r) => r.state === "NEEDS_ALLOWLIST").length === content.length && m.filter((r) => r.state === "READY").length === other.length, "the matrix covers all 12; only the six ticket-content features wait on the allow-list");
}

{
  const group = "P3.7 One hook, one text";
  const hook = read("src/components/command-center/use-ai-readiness.ts");
  ok(group, /title: r\.state === "READY" \? undefined : r\.nextStep/.test(hook), "the hook's tooltip IS the readiness nextStep (undefined when ready)");
  const where: Record<AiFeatureId, string> = {
    ticketAi: "TicketAiPanel", ticketBrief: "TicketBrief", smartTriage: "SmartTriagePanel", mentionReplyDrafter: "MentionReplyDrafter", audienceReports: "ReportRewrite", baRequirementCheck: "BaRequirementCheck",
    aiBlockerFollowUp: "AiFollowUpDrafter", releaseGoNoGo: "ReleaseGoNoGo", meetingNotesActions: "MeetingNotesActions", nlCommands: "CommandBar", weeklyInsights: "WeeklyInsights", nextBestActionAi: "NextBestActions",
  };
  for (const f of AI_FEATURES) {
    const src = read(`src/components/command-center/${where[f.id]}.tsx`);
    ok(group, new RegExp(`useAiReadiness\\("${f.id}"`).test(src) && /[Rr]eadiness\.title/.test(src), `${f.id}: ${where[f.id]} takes its tooltip from useAiReadiness("${f.id}")`);
  }
  ok(group, !/AI disabled for this project \(\$\{|allow it in Data &amp; Settings → AI data protection\./.test(read("src/components/command-center/TicketAiPanel.tsx")), "the ad-hoc 'allow it in Data & Settings' wording in TicketAiPanel is gone (readiness.nextStep instead)");
  ok(group, /<AiReadinessPanel \/>/.test(read("src/app/data-settings/page.tsx")), "the matrix is mounted in Data & Settings");
}

{
  const group = "P3.7 Presets";
  const base = { ...DEFAULT_FEATURE_TOGGLES };
  const rec = presetDiff(base, "recommended");
  ok(group, rec.map((c) => c.feature).sort().join() === "smartTriage,ticketBrief,weeklyInsights" && rec.every((c) => c.from === false && c.to === true) && AI_PRESETS.recommended.on.length === 3, "Recommended turns on smartTriage, ticketBrief, weeklyInsights (the diff lists exactly those)");
  const withOthers = { ...base, ticketAi: true, nlCommands: true };
  const recOthers = applyPreset(withOthers, "recommended");
  ok(group, recOthers.ticketAi === true && recOthers.nlCommands === true && recOthers.smartTriage === true, "Recommended leaves other switches as the user set them");
  ok(group, presetDiff(recOthers, "recommended").length === 0, "applying it twice changes nothing the second time (empty diff)");
  const off = applyPreset(recOthers, "all-off");
  ok(group, AI_FEATURES.every((f) => off[f.id] === false) && presetDiff(recOthers, "all-off").map((c) => c.feature).sort().join() === "nlCommands,smartTriage,ticketAi,ticketBrief,weeklyInsights", "All off switches every AI feature off");
  ok(group, off.morningMode === recOthers.morningMode && off.jiraWriteBack === recOthers.jiraWriteBack, "non-AI toggles are never touched");
  const diff = presetDiff(recOthers, "all-off");
  ok(group, JSON.stringify(undoPreset(off, diff)) === JSON.stringify(recOthers), "undo restores the exact previous toggles (apply/undo round-trips)");
  const diff2 = presetDiff(base, "recommended");
  ok(group, JSON.stringify(undoPreset(applyPreset(base, "recommended"), diff2)) === JSON.stringify(base), "…for Recommended too");

  // through the real store: the allow-list is untouched
  const { store } = v226Store();
  store.setAiProjectAllowed("ABC", true);
  const before = JSON.stringify(store.getSnapshot().aiDataProtection);
  const changes = presetDiff(store.getSnapshot().features, "recommended");
  for (const c of changes) store.setFeatureToggle(c.feature, c.to);
  ok(group, store.getSnapshot().features.smartTriage === true && JSON.stringify(store.getSnapshot().aiDataProtection) === before, "applying a preset through the store leaves the project allow-list byte-identical");
  for (const c of changes) store.setFeatureToggle(c.feature, c.from);
  ok(group, store.getSnapshot().features.smartTriage === false && JSON.stringify(store.getSnapshot().aiDataProtection) === before, "undo through the store too");
  const panel = read("src/components/command-center/AiReadinessPanel.tsx");
  ok(group, /data-ai-preset-diff/.test(panel) && /Apply/.test(panel) && /Undo last preset/.test(panel) && !/allowedProjectKeys\s*[:=]\s*\[/.test(panel) && !/setAiDataProtection|setAllowed/.test(panel), "the panel shows the diff before applying, offers Undo, and never touches the allow-list");
}

{
  const group = "P3.7 Model default (checked against Anthropic's models overview)";
  ok(group, DEFAULT_AI_MODEL_FAST === "claude-haiku-5-5" && resolveAiModel("interpretTrend", {}).model === "claude-haiku-5-5" && resolveAiModel("interpretTrend", {}).tier === "fast", "the fast tier now defaults to claude-haiku-5-5");
  ok(group, resolveAiModel("interpretTrend", { ANTHROPIC_MODEL_FAST: "claude-haiku-4-5" }).model === "claude-haiku-4-5" && aiModelStatus({ ANTHROPIC_MODEL_FAST: "claude-haiku-4-5" }).fastModelFromEnv && !aiModelStatus({}).fastModelFromEnv, "the ANTHROPIC_MODEL_* overrides still win (Haiku 4.5 stays selectable)");
  ok(group, isAlwaysThinkingModel("claude-haiku-5-5") && isAlwaysThinkingModel("claude-sonnet-5-5") && !isAlwaysThinkingModel("claude-haiku-4-5"), "the always-thinking pattern was updated together with the default (Haiku 5.5 gets the larger output budget; Haiku 4.5 does not)");
  ok(group, /claude-haiku-5-5/.test(read("README.md")) && /legacy/.test(read("README.md")), "README documents the change");
}
