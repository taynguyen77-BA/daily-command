"use client";

// Perf — long lists render progressively. A Jira install with thousands of tickets used to mount one card (with its own TaskRow, hooks and
// chips) per ticket: ~50-70k DOM nodes on Priorities / Risks / Attention, which froze the main thread for tens of seconds and made every
// menu link look dead while the page was busy. Now the first PAGE items render at once and "Show more" adds the next PAGE (or all).
// Filtering, sorting and counts still run over the FULL list — only what is mounted is windowed.

import { useState, type ReactNode } from "react";

export const PROGRESSIVE_PAGE = 30;

export function useProgressiveList<T>(items: readonly T[], resetKey: string = "", page: number = PROGRESSIVE_PAGE): { visible: readonly T[]; total: number; remaining: number; showMore: () => void; showAll: () => void } {
  // The window is remembered per filter (resetKey): changing a filter starts again from the first page.
  const [state, setState] = useState<{ key: string; count: number }>({ key: resetKey, count: page });
  const count = state.key === resetKey ? state.count : page;
  const shown = Math.min(count, items.length);
  return {
    visible: items.length <= count ? items : items.slice(0, count),
    total: items.length,
    remaining: items.length - shown,
    showMore: () => setState({ key: resetKey, count: count + page }),
    showAll: () => setState({ key: resetKey, count: items.length }),
  };
}

export function ShowMore({ remaining, total, onMore, onAll, noun = "items" }: { remaining: number; total: number; onMore: () => void; onAll: () => void; noun?: string }) {
  if (remaining <= 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 py-4 text-xs text-text3" data-show-more>
      <span>Showing {total - remaining} of {total} {noun}</span>
      <button type="button" onClick={onMore} className="rounded-md border border-border px-3 py-1 text-text2 hover:bg-surface2">Show {Math.min(PROGRESSIVE_PAGE, remaining)} more</button>
      {remaining > PROGRESSIVE_PAGE && <button type="button" onClick={onAll} className="rounded-md border border-border px-3 py-1 text-text2 hover:bg-surface2" title="Renders every item — slow with thousands of tickets">Show all {total}</button>}
    </div>
  );
}

/** A grid (or list) that mounts only the first page of `items`; the rest on demand. `render` is called for visible items only. */
export function ProgressiveGrid<T>({ items, resetKey = "", render, className = "grid gap-3 md:grid-cols-2", noun = "items", as: Tag = "div" }: { items: readonly T[]; resetKey?: string; render: (item: T) => ReactNode; className?: string; noun?: string; as?: "div" | "ul" }) {
  const { visible, total, remaining, showMore, showAll } = useProgressiveList(items, resetKey);
  return (
    <>
      <Tag className={className}>{visible.map(render)}</Tag>
      <ShowMore remaining={remaining} total={total} onMore={showMore} onAll={showAll} noun={noun} />
    </>
  );
}
