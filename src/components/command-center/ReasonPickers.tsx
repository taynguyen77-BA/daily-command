"use client";

// E3 — the ONE set of reason controls for Block and Skip, rendered by both TaskRow
// (TaskReferenceRow.tsx) and Focus Session, so the two can never offer different options again.
// Block: free text with quick-fill suggestions (BLOCK_REASON_SUGGESTIONS) — what blocks a
// ticket is specific. Skip: a fixed list (SKIP_REASONS), optional. "Not enough time today" is
// deliberately in neither: running out of time is a Defer (to a date), not a block.
// Past records that still carry it are shown as-is — never rewritten (see types.ts).

import React from "react";
import { BLOCK_REASON_SUGGESTIONS, SKIP_REASONS, type SkipReason } from "@/lib/command-center/types";

export const REASON_FIELD = "rounded-md border border-border2 bg-surface px-2 py-1 text-xs text-text2 focus:border-accent";

export function BlockReasonField({ listId, value, onChange, className = `w-44 ${REASON_FIELD}` }: { listId: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="Blocked on… (optional)"
        aria-label="Block reason (optional)"
        maxLength={200}
        className={className}
      />
      <datalist id={listId} data-reason-options="block">
        {BLOCK_REASON_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </>
  );
}

export function SkipReasonSelect({ value, onChange, className = REASON_FIELD }: { value: SkipReason | ""; onChange: (v: SkipReason | "") => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as SkipReason | "")} aria-label="Skip reason (optional)" data-reason-options="skip" className={className}>
      <option value="">No reason</option>
      {SKIP_REASONS.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}
