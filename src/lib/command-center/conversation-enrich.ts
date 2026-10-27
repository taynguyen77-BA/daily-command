// P3.2 — the sync's conversation step as one injectable unit (so the request count is testable offline):
// pick candidates, fetch each one's newest comments through the bounded pool before the deadline, compute states.

import { mapWithConcurrency } from "./jira/concurrency";
import { computeConversationState, type ConversationState } from "./conversation-state";
import { selectConversationCandidates, type ConversationCandidateInput } from "./conversation-select";
import type { JiraComment } from "./jira/types";

export interface ConversationEnrichInput extends ConversationCandidateInput {
  assigneeByKey: ReadonlyMap<string, string | undefined>;
  today: string;
  concurrency: number;
  deadline?: number;
  now?: () => number;
}

export async function enrichConversations(
  input: ConversationEnrichInput,
  fetchComments: (issueKey: string) => Promise<{ ok: true; data: JiraComment[] } | { ok: false }>
): Promise<{ conversation: Record<string, ConversationState>; requested: number; skipped: number }> {
  const candidates = selectConversationCandidates(input);
  const conversation: Record<string, ConversationState> = {};
  if (candidates.length === 0) return { conversation, requested: 0, skipped: 0 };
  const run = await mapWithConcurrency(
    candidates,
    input.concurrency,
    async (key) => {
      const r = await fetchComments(key);
      if (!r.ok) return;
      conversation[key] = computeConversationState({ comments: r.data, accountId: input.accountId, assigneeAccountId: input.assigneeByKey.get(key), open: true, today: input.today, issueUpdatedAt: input.issueUpdatedByKey[key] });
    },
    { deadline: input.deadline, now: input.now }
  );
  return { conversation, requested: candidates.length - run.skipped.length, skipped: run.skipped.length };
}
