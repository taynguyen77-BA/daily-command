// V2.14 §1 — "Is this mine to act on?" relation classification (Task 1). A second,
// orthogonal classification layered on top of every AttentionItem/PersonalFocusCandidate:
// AttentionCategory/FocusCategory answer "what kind of signal is this and how urgent is it
// for the engine's own ranking"; PersonalRelation answers a different, display/filter
// question the user reads directly — "what is this ticket's relationship to me". Never
// conflate the two: a DRIFT item can be `ownershipExplicit: false` (personal-focus.ts's own
// stricter, ambiguity-aware resolution) while still classifying as "ASSIGNED" here whenever
// the underlying WorkItem.ownerId plainly matches — that's expected, not a bug (see
// personal-focus.ts's own top comment).

// The `PersonalRelation` type itself lives in types.ts (this codebase's single import-free
// type root — see its own top comment) alongside AttentionCategory/FocusCategory; re-exported
// here so every call site that reasons about relations imports it from this module, where the
// classification logic actually lives.
import type { PersonalRelation, WorkItem } from "./types";
export type { PersonalRelation };

/** A minimal, decoupled identity view — same accountId-first/displayName-fallback shape as
 *  personal-focus.ts's own IdentityRef, kept independent (field named `accountId`, not
 *  `ownerId`, matching PersonalIdentity) so this module never has to import personal-focus.ts
 *  (which imports THIS module, to compute PersonalFocusCandidate.relation — see personal-focus.ts). */
export interface PersonalRelationIdentity {
  displayName?: string;
  accountId?: string;
}

/** V2.10 §1's accountId-first, displayName-fallback ownership comparison — the one
 *  implementation personal-focus.ts's isExplicitOwner and classifyPersonalRelation below both
 *  call, rather than two independently-maintained copies of the same "which field wins" rule. */
export function matchesIdentity(ownerId: string | undefined, ownerLabel: string | undefined, identity: PersonalRelationIdentity): boolean {
  if (identity.accountId) return !!ownerId && ownerId === identity.accountId;
  return !!identity.displayName && !!ownerLabel && ownerLabel === identity.displayName;
}

/** §1 — never guesses: UNKNOWN when neither `identity.accountId` nor `identity.displayName`
 *  is configured at all, regardless of what `item`/`mentionedIssueKeys` say. */
export function classifyPersonalRelation(
  item: Pick<WorkItem, "id" | "ownerId" | "owner">,
  identity: PersonalRelationIdentity,
  mentionedIssueKeys: ReadonlySet<string>,
  issueKey: string | undefined
): PersonalRelation {
  if (!identity.accountId && !identity.displayName) return "UNKNOWN";
  const assigned = matchesIdentity(item.ownerId, item.owner, identity);
  const mentioned = issueKey !== undefined && mentionedIssueKeys.has(issueKey);
  if (assigned && mentioned) return "ASSIGNED_AND_MENTIONED";
  if (assigned) return "ASSIGNED";
  if (mentioned) return "MENTIONED";
  return "FOLLOWING";
}

/** Task 4 — "My action items only": relation is ASSIGNED, ASSIGNED_AND_MENTIONED, or
 *  MENTIONED (i.e. excludes FOLLOWING and UNKNOWN/undefined). A plain predicate, not a new
 *  ranking concept — every page applies it as one more AND condition on top of whatever else
 *  is already selected. */
export function isMyActionItem(relation: PersonalRelation | undefined): boolean {
  return relation === "ASSIGNED" || relation === "ASSIGNED_AND_MENTIONED" || relation === "MENTIONED";
}
