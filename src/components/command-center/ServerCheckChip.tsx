"use client";

// P2.2 — a small header chip for the scheduled server check (green OK / amber LATE / red
// STALE, NEVER, ERROR). Hidden when no server-side machinery (KV) is configured.

import { useEffect, useState } from "react";
import { fetchServerHealthCached, selectServerCheck } from "@/lib/command-center/health-client";

const DOT = { green: "bg-green", amber: "bg-yellow", red: "bg-red" } as const;

export function ServerCheckChip() {
  const [check, setCheck] = useState<ReturnType<typeof selectServerCheck>>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchServerHealthCached().then((h) => {
      if (!cancelled) setCheck(selectServerCheck(h));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!check) return null;
  return (
    <span title={check.tooltip} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] text-text3">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[check.tone]}`} />
      {check.label}
    </span>
  );
}
