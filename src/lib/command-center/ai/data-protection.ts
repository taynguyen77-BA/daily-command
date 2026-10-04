// V2.36 H2 — data protection, enforced in the browser BEFORE any ticket content (H1) is put
// into an AI request:
//   1. Per-project allow-list (Data & Settings; default: no project allowed). A ticket outside
//      the list never has its description/comments sent — buildTicketAiInput refuses, and the
//      UI says "AI disabled for this project".
//   2. Redaction (redaction.ts): emails, phones, token URLs, account ids, card/IBAN-like numbers
//      → placeholders; custom terms → aliases, restored in the output.
//   3. "What will be sent" preview on the first use per project (previewSeenProjects).

import type { IssueContext } from "../jira/issue-context";
import { RedactionSession, type CustomTerm } from "./redaction";
import { ticketContextInputSchema, type TicketContextInput } from "./task-registry";
import type { AIProvider, RequirementCheckResult } from "./provider";

export interface AiDataProtectionSettings {
  /** Project keys whose ticket content may be sent to the model. Default: none. */
  allowedProjectKeys: string[];
  customTerms: CustomTerm[];
  /** Jira custom field holding acceptance criteria (customfield_<digits>), if any. */
  acceptanceCriteriaFieldId?: string;
  /** Project key → when the user first confirmed the "What will be sent" preview. */
  previewSeenProjects: Record<string, string>;
  /** Include the AI context cache in backups (off by default — it holds ticket content). */
  includeContextCacheInBackup: boolean;
}

export const DEFAULT_AI_DATA_PROTECTION: AiDataProtectionSettings = {
  allowedProjectKeys: [],
  customTerms: [],
  previewSeenProjects: {},
  includeContextCacheInBackup: false,
};

export const AI_DISABLED_FOR_PROJECT = "AI disabled for this project";

export const projectKeyOf = (issueKey: string) => issueKey.split("-")[0]?.toUpperCase() ?? "";

export function isProjectAiAllowed(settings: AiDataProtectionSettings, projectKey: string): boolean {
  return settings.allowedProjectKeys.includes(projectKey.toUpperCase());
}

export function needsSendPreview(settings: AiDataProtectionSettings, projectKey: string): boolean {
  return !settings.previewSeenProjects[projectKey.toUpperCase()];
}

export type TicketAiInputResult =
  | { allowed: false; reason: typeof AI_DISABLED_FOR_PROJECT }
  | { allowed: true; input: TicketContextInput; session: RedactionSession; redactions: number };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The ONLY way ticket content becomes an AI input. Not allow-listed → nothing is built. */
export function buildTicketAiInput(context: IssueContext, settings: AiDataProtectionSettings): TicketAiInputResult {
  const projectKey = (context.projectKey || projectKeyOf(context.key)).toUpperCase();
  if (!isProjectAiAllowed(settings, projectKey)) return { allowed: false, reason: AI_DISABLED_FOR_PROJECT };
  const session = new RedactionSession(settings.customTerms);
  const r = (s: string, max: number) => session.redact(clip(s, max));
  const input: TicketContextInput = {
    key: context.key,
    projectKey,
    summary: r(context.summary, 2000),
    status: context.status.slice(0, 200),
    description: r(context.description, 20_000),
    ...(context.acceptanceCriteria !== undefined ? { acceptanceCriteria: r(context.acceptanceCriteria, 20_000) } : {}),
    comments: context.comments.slice(-20).map((c) => ({ author: r(c.author, 200), created: c.created.slice(0, 40), body: r(c.body, 4000) })),
    links: context.links.slice(0, 50).map((l) => ({ key: l.key, summary: r(l.summary, 1000), status: l.status.slice(0, 200), relation: l.relation.slice(0, 200) })),
    statusHistory: context.statusHistory.slice(-10).map((h) => ({ at: h.at.slice(0, 40), from: h.from.slice(0, 200), to: h.to.slice(0, 200) })),
  };
  // Same schema the server applies — what passes here is exactly what will be sent.
  return { allowed: true, input: ticketContextInputSchema.parse(input), session, redactions: session.totalRedactions };
}

/** Human-readable "What will be sent" preview — the redacted input, as the model will see it. */
export function describeTicketPayload(input: TicketContextInput): string {
  const lines = [
    `${input.key} — ${input.summary}`,
    `Status: ${input.status}`,
    "",
    "Description:",
    input.description || "(empty)",
  ];
  if (input.acceptanceCriteria !== undefined) lines.push("", "Acceptance criteria:", input.acceptanceCriteria || "(empty)");
  if (input.comments.length) {
    lines.push("", `Comments (${input.comments.length}):`);
    for (const c of input.comments) lines.push(`- ${c.author}, ${c.created.slice(0, 10)}: ${c.body}`);
  }
  if (input.links.length) {
    lines.push("", "Linked issues:");
    for (const l of input.links) lines.push(`- ${l.relation} ${l.key} — ${l.summary} [${l.status}]`);
  }
  if (input.statusHistory.length) {
    lines.push("", "Status history:");
    for (const h of input.statusHistory) lines.push(`- ${h.at.slice(0, 10)}: ${h.from} → ${h.to}`);
  }
  return lines.join("\n");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Tolerant parse for stored state (never throws; anything odd falls back to the default). */
export function asAiDataProtectionSettings(raw: unknown): AiDataProtectionSettings {
  if (!isObj(raw)) return { ...DEFAULT_AI_DATA_PROTECTION, previewSeenProjects: {} };
  const keys = Array.isArray(raw.allowedProjectKeys) ? raw.allowedProjectKeys.filter((k): k is string => typeof k === "string" && /^[A-Z][A-Z0-9_]{0,19}$/.test(k)) : [];
  const terms = Array.isArray(raw.customTerms)
    ? raw.customTerms.filter((t): t is CustomTerm => isObj(t) && typeof t.term === "string" && (t.alias === undefined || typeof t.alias === "string")).slice(0, 100)
    : [];
  const seen = isObj(raw.previewSeenProjects) ? Object.fromEntries(Object.entries(raw.previewSeenProjects).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
  const acField = typeof raw.acceptanceCriteriaFieldId === "string" && /^customfield_\d{1,9}$/.test(raw.acceptanceCriteriaFieldId) ? raw.acceptanceCriteriaFieldId : undefined;
  return {
    allowedProjectKeys: Array.from(new Set(keys)),
    customTerms: terms.map((t) => (t.alias ? { term: t.term, alias: t.alias } : { term: t.term })),
    ...(acField ? { acceptanceCriteriaFieldId: acField } : {}),
    previewSeenProjects: seen,
    includeContextCacheInBackup: raw.includeContextCacheInBackup === true,
  };
}

// ===== The gate every task over one ticket's content goes through =====

export type TicketAiGate =
  | { kind: "disabled"; reason: typeof AI_DISABLED_FOR_PROJECT }
  | { kind: "needs-preview"; input: TicketContextInput; session: RedactionSession; redactions: number; preview: string }
  | { kind: "ready"; input: TicketContextInput; session: RedactionSession };

/** Allow-list → redaction → first-use preview. Nothing built here reaches a provider for a
 *  project outside the allow-list, or before the first-use preview was confirmed. */
export function gateTicketAi(context: IssueContext, settings: AiDataProtectionSettings, opts: { previewConfirmed?: boolean } = {}): TicketAiGate {
  const built = buildTicketAiInput(context, settings);
  if (!built.allowed) return { kind: "disabled", reason: built.reason };
  if (needsSendPreview(settings, built.input.projectKey) && !opts.previewConfirmed) {
    return { kind: "needs-preview", input: built.input, session: built.session, redactions: built.redactions, preview: describeTicketPayload(built.input) };
  }
  return { kind: "ready", input: built.input, session: built.session };
}

export type RequirementCheckFlow = Exclude<TicketAiGate, { kind: "ready" }> | { kind: "done"; result: RequirementCheckResult };

/** Requirement check: gate → model (or deterministic fallback) → aliases restored. */
export async function runRequirementCheckFlow(
  context: IssueContext,
  settings: AiDataProtectionSettings,
  provider: Pick<AIProvider, "checkRequirements">,
  opts: { previewConfirmed?: boolean } = {}
): Promise<RequirementCheckFlow> {
  const gate = gateTicketAi(context, settings, opts);
  if (gate.kind !== "ready") return gate;
  const raw = await provider.checkRequirements(gate.input);
  return { kind: "done", result: gate.session.restoreDeep(raw) };
}
