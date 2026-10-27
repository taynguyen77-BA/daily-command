// P3.7 — "why can't I use this AI feature, and what is the next step?" One pure answer per feature, from facts
// the app already has (the feature toggle, the AI status endpoint, today's usage, the project allow-list).
// Every AI button reads its tooltip from here (use-ai-readiness.ts), so no two places can disagree.

import type { FeatureToggles } from "../types";

export type AiFeatureId = "ticketAi" | "ticketBrief" | "smartTriage" | "mentionReplyDrafter" | "audienceReports" | "baRequirementCheck" | "aiBlockerFollowUp" | "releaseGoNoGo" | "meetingNotesActions" | "nlCommands" | "weeklyInsights" | "nextBestActionAi";

export type AiReadinessState = "READY" | "OFF" | "NEEDS_KEY" | "NEEDS_ALLOWLIST" | "SERVER_POLICY_BLOCKED" | "CAP_REACHED";

/** The 12 AI features. `ticketContent` = it sends ticket content to the model, so the project allow-list (and the
 *  server's AI_ALLOWED_PROJECT_KEYS) apply — the same set of features that call isProjectAiAllowed / gateTicketAi. */
export const AI_FEATURES: { id: AiFeatureId; label: string; ticketContent: boolean }[] = [
  { id: "ticketAi", label: "Ticket AI (requirement gaps)", ticketContent: true },
  { id: "ticketBrief", label: "Ticket brief", ticketContent: true },
  { id: "smartTriage", label: "Smart triage of New", ticketContent: true },
  { id: "mentionReplyDrafter", label: "Draft reply to a mention", ticketContent: true },
  { id: "audienceReports", label: "Audience reports", ticketContent: false },
  { id: "baRequirementCheck", label: "BA requirement check", ticketContent: true },
  { id: "aiBlockerFollowUp", label: "AI blocker follow-ups", ticketContent: true },
  { id: "releaseGoNoGo", label: "Release go/no-go brief", ticketContent: false },
  { id: "meetingNotesActions", label: "Meeting notes → actions", ticketContent: false },
  { id: "nlCommands", label: "Command Bar commands", ticketContent: false },
  { id: "weeklyInsights", label: "Weekly insights", ticketContent: false },
  { id: "nextBestActionAi", label: "Next Best Action wording", ticketContent: false },
];

export interface AiReadinessContext {
  features: Pick<FeatureToggles, AiFeatureId>;
  /** GET /api/command-center/ai: null = not known yet (never produces a "needs key" claim). */
  ai: { available: boolean; aiAllowedProjectKeys?: string[] | null } | null;
  /** Today's usage: null = unknown. */
  usage: { remainingToday: number } | null;
  /** The browser-side allow-list (Data & Settings -> AI data protection). */
  allowedProjectKeys: readonly string[];
  /** Project keys present in the synced data. */
  projectKeys: readonly string[];
  /** A ticket-scoped button passes its project; the allow-list checks then concern that project. */
  projectKey?: string;
}

export interface AiReadiness {
  feature: AiFeatureId;
  state: AiReadinessState;
  nextStep: string;
  /** Projects whose content this feature may use / projects in the data. Features that do not send ticket content are not restricted. */
  projects: { allowed: number; total: number };
}

export const READY_TEXT = "Ready.";

/** Precedence: OFF > NEEDS_KEY > NEEDS_ALLOWLIST > SERVER_POLICY_BLOCKED > CAP_REACHED > READY. */
export function aiReadiness(feature: AiFeatureId, ctx: AiReadinessContext): AiReadiness {
  const def = AI_FEATURES.find((f) => f.id === feature)!;
  const upper = (k: string) => k.toUpperCase();
  const total = new Set(ctx.projectKeys.map(upper)).size;
  const client = new Set(ctx.allowedProjectKeys.map(upper));
  const server = ctx.ai && "aiAllowedProjectKeys" in ctx.ai && ctx.ai.aiAllowedProjectKeys ? new Set(ctx.ai.aiAllowedProjectKeys.map(upper)) : null; // null = no server restriction (or not visible)
  const inData = Array.from(new Set(ctx.projectKeys.map(upper)));
  const allowedCount = def.ticketContent ? inData.filter((k) => client.has(k) && (!server || server.has(k))).length : total;
  const projects = { allowed: allowedCount, total };
  const done = (state: AiReadinessState, nextStep: string): AiReadiness => ({ feature, state, nextStep, projects });

  if (!ctx.features[feature]) return done("OFF", `Turn on “${def.label}” in Data & Settings → Features.`);
  if (ctx.ai && !ctx.ai.available) return done("NEEDS_KEY", "Set ANTHROPIC_API_KEY on the server — until then this runs in Mock AI mode (deterministic text, no model).");
  if (def.ticketContent) {
    const scope = ctx.projectKey ? [upper(ctx.projectKey)] : null;
    const clientOk = scope ? scope.every((k) => client.has(k)) : client.size > 0;
    if (!clientOk) return done("NEEDS_ALLOWLIST", ctx.projectKey ? `Allow project ${upper(ctx.projectKey)} in Data & Settings → AI data protection.` : "Allow at least one project in Data & Settings → AI data protection.");
    const serverOk = !server || (scope ? scope.every((k) => server.has(k)) : Array.from(client).some((k) => server.has(k)));
    if (!serverOk) return done("SERVER_POLICY_BLOCKED", `The server's AI_ALLOWED_PROJECT_KEYS (${Array.from(server!).join(", ") || "none"}) does not include ${ctx.projectKey ? upper(ctx.projectKey) : "any project you allowed"} — ask the server admin, or allow a listed project.`);
  }
  if (ctx.usage && ctx.usage.remainingToday <= 0) return done("CAP_REACHED", "The daily AI token cap is reached — it resets at 00:00 UTC (the server admin can raise AI_DAILY_TOKEN_CAP).");
  return done("READY", READY_TEXT);
}

export function aiReadinessMatrix(ctx: Omit<AiReadinessContext, "projectKey">): AiReadiness[] {
  return AI_FEATURES.map((f) => aiReadiness(f.id, ctx));
}

// ----- presets -----

export type AiPreset = "recommended" | "all-off";
export const AI_PRESETS: Record<AiPreset, { label: string; on: readonly AiFeatureId[] }> = {
  recommended: { label: "Recommended", on: ["smartTriage", "ticketBrief", "weeklyInsights"] },
  "all-off": { label: "All off", on: [] },
};

export interface PresetChange {
  feature: AiFeatureId;
  from: boolean;
  to: boolean;
}

/** What applying a preset would change (nothing for a toggle already in place). Never touches the allow-list. */
export function presetDiff(features: Pick<FeatureToggles, AiFeatureId>, preset: AiPreset): PresetChange[] {
  const on = new Set(AI_PRESETS[preset].on);
  const out: PresetChange[] = [];
  for (const f of AI_FEATURES) {
    // "Recommended" only switches its three features ON and leaves every other toggle as the user set it; "All off" switches every AI toggle off.
    const to = preset === "recommended" ? (on.has(f.id) ? true : features[f.id]) : false;
    if (features[f.id] !== to) out.push({ feature: f.id, from: features[f.id], to });
  }
  return out;
}

export function applyPreset<T extends Pick<FeatureToggles, AiFeatureId>>(features: T, preset: AiPreset): T {
  const next = { ...features };
  for (const c of presetDiff(features, preset)) next[c.feature] = c.to;
  return next;
}

/** The inverse of a diff, for Undo. */
export function undoPreset<T extends Pick<FeatureToggles, AiFeatureId>>(features: T, changes: readonly PresetChange[]): T {
  const next = { ...features };
  for (const c of changes) next[c.feature] = c.from;
  return next;
}
