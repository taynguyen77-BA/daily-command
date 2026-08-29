"use client";

import type { ChangeEvent } from "@/lib/command-center/types";

export function ChangeItem({ change }: { change: ChangeEvent }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-text3">
        <span className="rounded border border-border px-1.5 py-0.5">{change.entityType}</span>
        <span>{change.field}</span>
      </div>
      <p className="font-display text-sm text-text">{change.entityLabel}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-text3 line-through decoration-text3/50">{change.before}</span>
        <span className="text-text3">→</span>
        <span className="font-medium text-text">{change.after}</span>
      </p>
      <p className="mt-2 text-xs text-text2">Impact: {change.impact}</p>
    </div>
  );
}
