// V2.17 §1a point 4 — display-layer grouping for MENTION items, kept entirely separate from
// the underlying comment-granular lifecycle tracking (attention-queue.ts, store.ts). Now that
// a ticket with 3 unresolved mention comments produces 3 independent AttentionItems/
// PersonalFocusCandidates (each with its own NEW->ACKNOWLEDGED->RESOLVED lifecycle — the whole
// point of this task's fix), a naive render would show 3 separate cards for one ticket. This
// folds still-visible MENTION entries sharing the same ticket into a single representative
// card labeled with the real count, without touching how any of them are tracked, acknowledged,
// or resolved individually.
//
// Generic over T (AttentionItem on the Attention Queue, PersonalFocusCandidate on My Day) via
// plain accessor callbacks, rather than two near-duplicate implementations.

export interface MentionGroupingOptions<T> {
  isMention: (item: T) => boolean;
  /** The ticket to group by. Returning undefined means "never group this one" (e.g. a
   *  mention whose underlying work item couldn't be resolved at all — kept as its own card
   *  rather than silently merged with unrelated items). */
  groupKey: (item: T) => string | undefined;
  /** ISO-comparable recency marker used only to pick which item in a group is the
   *  representative (the most recent one) — never used to reorder the array itself. */
  recency: (item: T) => string;
  /** Produces the single card shown for a group of 2+ items, from the most recent one plus
   *  the real group size. */
  relabel: (mostRecent: T, count: number) => T;
}

/** Folds every same-ticket MENTION entry (including a lone survivor after resolved siblings
 *  are filtered out upstream) into one relabeled representative, in place of the group's
 *  first occurrence — every other item's slot in `items` is dropped. Always relabeling, even
 *  a group of exactly one, keeps the displayed count trustworthy on its own: a card reading
 *  "1 new comment" always means exactly one is actually still open, never an artifact of
 *  whether grouping happened to kick in. Non-mention items and ungroupable mentions (no
 *  resolvable ticket) pass through completely unchanged, at their original position. */
export function groupMentionItems<T>(items: T[], options: MentionGroupingOptions<T>): T[] {
  const { isMention, groupKey, recency, relabel } = options;

  const groups = new Map<string, T[]>();
  const firstIndexOfKey = new Map<string, number>();
  items.forEach((item, index) => {
    if (!isMention(item)) return;
    const key = groupKey(item);
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, []);
      firstIndexOfKey.set(key, index);
    }
    groups.get(key)!.push(item);
  });

  const out: T[] = [];
  items.forEach((item, index) => {
    if (!isMention(item)) {
      out.push(item);
      return;
    }
    const key = groupKey(item);
    if (!key) {
      out.push(item);
      return;
    }
    const group = groups.get(key)!;
    if (firstIndexOfKey.get(key) !== index) return; // folded into the representative below
    const mostRecent = [...group].sort((a, b) => (recency(a) < recency(b) ? 1 : -1))[0];
    out.push(relabel(mostRecent, group.length));
  });
  return out;
}

/** Shared label text for a grouped mention card, e.g. "Mentioned you — 2 new comments". */
export function mentionGroupLabel(count: number): string {
  return `Mentioned you — ${count} new comment${count === 1 ? "" : "s"}`;
}
