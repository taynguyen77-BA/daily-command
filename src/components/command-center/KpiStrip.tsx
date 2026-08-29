"use client";

import Link from "next/link";
import type { Kpis } from "@/lib/command-center/selectors";

const TILES: { key: keyof Kpis; label: string; href: string; color: string }[] = [
  { key: "needAttention", label: "NEED ATTENTION", href: "/priorities?filter=CRITICAL", color: "text-red" },
  { key: "watching", label: "WATCHING", href: "/priorities?filter=HIGH", color: "text-orange" },
  { key: "onTrack", label: "ON TRACK", href: "/priorities?filter=ON_TRACK", color: "text-green" },
  { key: "overdue", label: "OVERDUE", href: "/priorities?filter=OVERDUE", color: "text-yellow" },
];

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {TILES.map((tile) => (
        <Link
          key={tile.key}
          href={tile.href}
          className="rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-accent"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">{tile.label}</p>
          <p className={`mt-1 font-display text-2xl font-semibold ${tile.color}`}>{kpis[tile.key]}</p>
        </Link>
      ))}
    </div>
  );
}
