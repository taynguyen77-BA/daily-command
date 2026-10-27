// P3.2 — which tickets get a comment fetch on a sync, at bounded cost. Pure.

export const DEFAULT_CONVERSATION_ENRICH_CAP = 25;

/** CONVERSATION_ENRICH_CAP (integer 0-100, default 25; 0 turns the enrichment off). */
export function conversationEnrichCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CONVERSATION_ENRICH_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONVERSATION_ENRICH_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_CONVERSATION_ENRICH_CAP;
}

export interface ConversationCandidateInput {
  workItems: readonly { key: string; status: string; blocked: boolean; ownerId?: string }[];
  accountId: string;
  mentionedKeys: readonly string[];
  /** The sync's own top-scored / prioritised keys. */
  topKeys: readonly string[];
  /** key -> the issue's `updated` as the sync just fetched it. */
  issueUpdatedByKey: Readonly<Record<string, string | undefined>>;
  /** What the client already holds: key -> issueUpdatedAt of its cached ConversationState. */
  cache: Readonly<Record<string, string>> | undefined;
  cap: number;
}

/** Open tickets that are mine, blocked, mentioned or top-scored (in that order of priority), minus those whose
 *  (key, updatedAt) is unchanged since the client's cached state, capped. The cap counts only tickets that
 *  would actually be fetched, so cached ones never consume it. */
export function selectConversationCandidates(input: ConversationCandidateInput): string[] {
  if (input.cap <= 0) return [];
  const open = new Map(input.workItems.filter((w) => w.status !== "Done").map((w) => [w.key, w]));
  const ordered = [
    ...input.mentionedKeys,
    ...input.workItems.filter((w) => w.ownerId === input.accountId).map((w) => w.key),
    ...input.workItems.filter((w) => w.blocked).map((w) => w.key),
    ...input.topKeys,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ordered) {
    if (seen.has(key) || !open.has(key)) continue;
    seen.add(key);
    const updated = input.issueUpdatedByKey[key];
    if (updated && input.cache?.[key] === updated) continue; // unchanged since the cached state -> no request
    out.push(key);
    if (out.length >= input.cap) break;
  }
  return out;
}
