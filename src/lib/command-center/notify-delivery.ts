// C1 — delivery bookkeeping for the default (non-smart) server-side notify path. Pure.
// A signal counts as notified only when its Slack post succeeded; otherwise it stays "new" for the next
// run, up to MAX_DELIVERY_ATTEMPTS failures, after which it is dropped (and counted) rather than retried forever.

export const MAX_DELIVERY_ATTEMPTS = 5;
export const MAX_DELIVERY_ATTEMPT_ENTRIES = 100;
/** Separate Slack messages per run on the default path; the rest wait (one "+N more" line) and drain next runs. */
export const DEFAULT_MAX_PER_RUN = 10;

export interface DeliveryAttempt {
  /** `M:<commentId>` for a mention, `A:<issueKey>` for an assignment. */
  id: string;
  /** Failed posts so far. */
  n: number;
}

export const mentionSignalId = (commentId: string) => `M:${commentId}`;
export const assignmentSignalId = (issueKey: string) => `A:${issueKey}`;

export interface DeliveryOutcome {
  id: string;
  /** Posted, or deferred by the flood guard (deferred is neither a success nor a failed attempt). */
  status: "delivered" | "failed" | "deferred";
}

export interface AttemptUpdate {
  attempts: DeliveryAttempt[];
  /** Signals still to be re-announced next run. */
  pending: Set<string>;
  /** Signals given up on this run (their 6th failed attempt). */
  dropped: string[];
}

/** Folds this run's outcomes into the persisted attempt counters. FIFO-capped. */
export function applyDeliveryOutcomes(previous: readonly DeliveryAttempt[] | undefined, outcomes: readonly DeliveryOutcome[]): AttemptUpdate {
  const counts = new Map<string, number>((previous ?? []).map((a) => [a.id, a.n]));
  const pending = new Set<string>();
  const dropped: string[] = [];
  for (const o of outcomes) {
    if (o.status === "delivered") {
      counts.delete(o.id);
    } else if (o.status === "deferred") {
      pending.add(o.id);
    } else {
      const failedBefore = counts.get(o.id) ?? 0;
      if (failedBefore >= MAX_DELIVERY_ATTEMPTS) {
        counts.delete(o.id);
        dropped.push(o.id);
      } else {
        counts.set(o.id, failedBefore + 1);
        pending.add(o.id);
      }
    }
  }
  // Counters of signals that are no longer pending (e.g. unassigned meanwhile) are forgotten with the FIFO cap.
  const attempts = Array.from(counts, ([id, n]) => ({ id, n }));
  return { attempts: attempts.length > MAX_DELIVERY_ATTEMPT_ENTRIES ? attempts.slice(attempts.length - MAX_DELIVERY_ATTEMPT_ENTRIES) : attempts, pending, dropped };
}
