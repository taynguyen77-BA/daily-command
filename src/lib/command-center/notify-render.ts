// P3.5 — Slack text for smart notifications: priority marker, age, a one-line reason, the link. Separate from
// renderSlackText (server/slack-notify.ts), which the browser path keeps using unchanged; with default
// preferences the cron also keeps using renderSlackText, so its output stays byte-identical.

import type { DigestItem } from "./notify-digest";

const ICON: Record<DigestItem["kind"], string> = { MENTION: "💬", ASSIGNMENT: "📌", ESCALATION: "⏳" };
const REASON: Record<DigestItem["kind"], (i: DigestItem) => string> = {
  MENTION: (i) => `mentioned you: ${i.detail}`,
  ASSIGNMENT: () => "assigned to you",
  ESCALATION: (i) => i.detail,
};

/** "2d ago" / "3h ago" / "just now" — relative to `now`, from the event time. */
export function ageText(atIso: string | undefined, now: Date): string {
  if (!atIso) return "";
  const t = new Date(atIso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (mins < 5) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (24 * 60))}d ago`;
}

export function renderSmartLine(item: DigestItem, now: Date): string {
  const age = ageText(item.at, now);
  return `${item.urgent ? "🔴 Urgent · " : ""}${ICON[item.kind]} ${item.issueKey} — ${item.summary} — ${REASON[item.kind](item)}${age ? ` (${age})` : ""}${item.url ? ` ${item.url}` : ""}`;
}

export function renderDigest(items: readonly DigestItem[], now: Date): string {
  const urgent = items.filter((i) => i.urgent).length;
  return [`📋 Digest — ${items.length} update${items.length === 1 ? "" : "s"}${urgent > 0 ? ` (${urgent} urgent)` : ""}`, ...items.map((i) => `• ${renderSmartLine(i, now)}`)].join("\n");
}

export function renderMoreSummary(items: readonly DigestItem[]): string {
  return `➕ +${items.length} more: ${items.slice(0, 10).map((i) => i.issueKey).join(", ")}${items.length > 10 ? ", …" : ""}`;
}
