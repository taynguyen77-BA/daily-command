// V2.53 fix 4 — the Morning Briefing card mirrors {prefs, snapshot, links} to the server after every recompute. The
// snapshot's `builtAt` changes each time, so a byte comparison never matched; this signature ignores it, so an
// unchanged briefing is not POSTed again (the reminders mirror already works this way via indexSignature).

import type { BriefingPrefs, BriefingRecord, BriefingSnapshot } from "./briefing";

export function briefingMirrorSignature(prefs: BriefingPrefs, snapshot: BriefingSnapshot | undefined, links: BriefingRecord["links"] | undefined): string {
  return JSON.stringify({ prefs, snapshot: snapshot ? { ...snapshot, builtAt: "" } : null, links: links ?? null });
}

export const shouldPostBriefing = (lastSignature: string | null, signature: string): boolean => lastSignature !== signature;
