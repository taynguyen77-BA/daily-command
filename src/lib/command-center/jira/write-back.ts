// F4 — optional Jira write-back. OFF by default. When on, and ONLY for a project on the
// allow-list:
//   - Block → offer a Jira comment "Blocked: <reason>" (and, if configured, set the Flag);
//   - Done  → offer a transition, chosen per project from the transitions Jira says are
//             available for that ticket.
// Nothing is ever written without the confirmation dialog: planJiraWriteBack only PROPOSES
// (and returns null whenever writing isn't allowed), executeJiraWriteBack runs only the writes
// the user ticked, and every attempt — success or failure — is logged in history.
//
// Pure (the request sender and the log are injected) so these rules are tested offline.

import type { FeatureToggles, JiraWriteBackSettings, JiraWriteLogEntry } from "../types";

export type JiraWriteTrigger = "block" | "done" | "reply";

export type ProposedJiraWrite =
  | { kind: "comment"; text: string }
  | { kind: "flag"; fieldId: string }
  | { kind: "transition"; preferredName?: string };

export interface JiraWriteBackProposal {
  ticketKey: string;
  projectKey: string;
  trigger: JiraWriteTrigger;
  writes: ProposedJiraWrite[];
  /** V2.37 I3 — "reply": the mention comment this answers; marked replied once posted. */
  mentionCommentId?: string;
}

export function projectKeyOf(ticketKey: string): string | undefined {
  return /^([A-Z][A-Z0-9_]{0,19})-\d+$/.exec(ticketKey)?.[1];
}

export function blockedCommentText(reason: string | undefined): string {
  return `Blocked: ${reason?.trim() || "no reason given"}`;
}

/** What to offer after a Block/Done — or null when nothing may be written: the feature is off,
 *  the ticket's project isn't allow-listed, or the key isn't a Jira key. */
export function planJiraWriteBack(input: {
  features: Pick<FeatureToggles, "jiraWriteBack">;
  settings: JiraWriteBackSettings;
  ticketKey: string;
  trigger: JiraWriteTrigger;
  reason?: string;
}): JiraWriteBackProposal | null {
  if (!input.features.jiraWriteBack) return null;
  const projectKey = projectKeyOf(input.ticketKey);
  if (!projectKey || !input.settings.projects.includes(projectKey)) return null;
  const writes: ProposedJiraWrite[] =
    input.trigger === "block"
      ? [{ kind: "comment", text: blockedCommentText(input.reason) }, ...(input.settings.setFlag && input.settings.flagFieldId ? [{ kind: "flag" as const, fieldId: input.settings.flagFieldId }] : [])]
      : [{ kind: "transition", ...(input.settings.doneTransitions[projectKey] ? { preferredName: input.settings.doneTransitions[projectKey] } : {}) }];
  return { ticketKey: input.ticketKey, projectKey, trigger: input.trigger, writes };
}

/** V2.37 I3 — "Post to Jira" for a drafted mention reply. Same rules as every other write: null
 *  unless write-back is on and the project is allow-listed; it only PROPOSES — the confirmation
 *  dialog (with the editable preview) and the server gate still decide. */
export function planJiraReply(input: {
  features: Pick<FeatureToggles, "jiraWriteBack">;
  settings: JiraWriteBackSettings;
  ticketKey: string;
  text: string;
  mentionCommentId: string;
}): JiraWriteBackProposal | null {
  if (!input.features.jiraWriteBack || !input.text.trim()) return null;
  const projectKey = projectKeyOf(input.ticketKey);
  if (!projectKey || !input.settings.projects.includes(projectKey)) return null;
  return { ticketKey: input.ticketKey, projectKey, trigger: "reply", writes: [{ kind: "comment", text: input.text.trim().slice(0, 2000) }], mentionCommentId: input.mentionCommentId };
}

/** One request to the server route. */
export type JiraWriteRequest =
  | { action: "comment"; issueKey: string; text: string }
  | { action: "flag"; issueKey: string; fieldId: string }
  | { action: "transition"; issueKey: string; transitionId: string };

export type JiraWriteSender = (req: JiraWriteRequest) => Promise<{ ok: boolean; error?: string }>;

/** What the user ticked in the confirmation dialog. */
export interface JiraWriteChoices {
  comment?: boolean;
  /** The comment text as confirmed (defaults to the proposal's). */
  commentText?: string;
  flag?: boolean;
  /** The transition picked from the ticket's available transitions (none = don't transition). */
  transition?: { id: string; name: string };
}

/** Runs the confirmed writes, in order, logging each attempt. Nothing runs that wasn't both
 *  proposed AND ticked. */
export async function executeJiraWriteBack(
  proposal: JiraWriteBackProposal,
  choices: JiraWriteChoices,
  send: JiraWriteSender,
  log: (entry: Omit<JiraWriteLogEntry, "id" | "at">) => void
): Promise<{ attempted: number; failed: number; commentPosted: boolean }> {
  let commentPosted = false;
  let attempted = 0;
  let failed = 0;
  const run = async (req: JiraWriteRequest, kind: JiraWriteLogEntry["kind"], detail: string) => {
    attempted++;
    let result: { ok: boolean; error?: string };
    try {
      result = await send(req);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
    if (!result.ok) failed++;
    else if (kind === "comment") commentPosted = true;
    log({ ticketKey: proposal.ticketKey, kind, detail, ok: result.ok, ...(result.error ? { error: result.error } : {}), trigger: proposal.trigger });
  };
  for (const w of proposal.writes) {
    if (w.kind === "comment" && choices.comment) {
      const text = choices.commentText?.trim() || w.text;
      await run({ action: "comment", issueKey: proposal.ticketKey, text }, "comment", text);
    }
    if (w.kind === "flag" && choices.flag) await run({ action: "flag", issueKey: proposal.ticketKey, fieldId: w.fieldId }, "flag", "Flagged (Impediment)");
    if (w.kind === "transition" && choices.transition) await run({ action: "transition", issueKey: proposal.ticketKey, transitionId: choices.transition.id }, "transition", choices.transition.name);
  }
  return { attempted, failed, commentPosted };
}

/** The transition to pre-select: the project's saved name (case-insensitive), else none. */
export function preselectTransition(transitions: { id: string; name: string }[], preferredName: string | undefined): { id: string; name: string } | undefined {
  if (!preferredName) return undefined;
  return transitions.find((t) => t.name.toLowerCase() === preferredName.toLowerCase());
}

// ===== Server side (the route's logic, testable with a fake fetch) =====================

/** Executes one validated request against a provider (HttpJiraActionProvider on the server).
 *  "list-transitions" is the dialog's read of what Done may offer. */
export async function performJiraWrite(
  provider: Pick<import("./jira-action-provider").JiraActionProvider, "addComment" | "updateIssue" | "transitionIssue" | "listTransitions">,
  req: JiraWriteRequest | { action: "list-transitions"; issueKey: string }
): Promise<{ ok: true; transitions?: import("./jira-action-provider").JiraTransition[] } | { ok: false; error: string }> {
  try {
    if (req.action === "list-transitions") return { ok: true, transitions: await provider.listTransitions(req.issueKey) };
    if (req.action === "comment") await provider.addComment(req.issueKey, req.text);
    else if (req.action === "flag") await provider.updateIssue(req.issueKey, { [req.fieldId]: [{ value: "Impediment" }] });
    else await provider.transitionIssue(req.issueKey, req.transitionId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Jira write failed" };
  }
}
