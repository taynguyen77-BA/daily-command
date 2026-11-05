// W1 — GET: the stored briefing record (prefs + snapshot + last sent day). POST: the client mirrors its prefs and compact snapshot
// (Next Best Actions, slip risks, mentions awaiting you — keys and short reasons only). Same auth as the reminders mirror; same-origin writes.

import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/command-center/auth/principal";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { asBriefingPrefs, asBriefingRecord, mergeClientBriefing } from "@/lib/command-center/briefing";
import { createBriefingStore } from "@/lib/server/briefing-store";
import { mirrorWho, noStore } from "@/lib/server/mirror-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_CHARS = 100_000;

export async function GET(req: Request) {
  const w = await mirrorWho(req);
  if (!w.ok) return w.res;
  let record = null;
  if (isNotifyStoreConfigured()) { try { record = await createBriefingStore(w.uid).get(); } catch { record = null; } }
  return NextResponse.json({ ok: true, active: w.active, kvConfigured: isNotifyStoreConfigured(), record }, { headers: noStore });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req.headers.get("origin"), req.headers.get("host"), process.env.NEXTAUTH_URL) && !req.headers.get("authorization")) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403, headers: noStore });
  }
  const w = await mirrorWho(req);
  if (!w.ok) return w.res;
  if (!isNotifyStoreConfigured()) return NextResponse.json({ ok: false, saved: false, reason: "not-configured" }, { headers: noStore });
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false, error: "Too large." }, { status: 413, headers: noStore });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400, headers: noStore }); }
  const body = raw as { prefs?: unknown; snapshot?: unknown; links?: unknown } | null;
  const parsed = asBriefingRecord({ prefs: asBriefingPrefs(body?.prefs), snapshot: body?.snapshot, links: body?.links });
  if (!parsed) return NextResponse.json({ ok: false, error: "Not a briefing record." }, { status: 400, headers: noStore });
  try {
    const store = createBriefingStore(w.uid);
    const merged = mergeClientBriefing(await store.get().catch(() => null), { prefs: parsed.prefs, ...(parsed.snapshot ? { snapshot: parsed.snapshot } : {}), ...(parsed.links ? { links: parsed.links } : {}) });
    await store.set(merged);
    return NextResponse.json({ ok: true, saved: true, active: w.active }, { headers: noStore });
  } catch {
    return NextResponse.json({ ok: false, saved: false, reason: "kv-unavailable" }, { status: 503, headers: noStore });
  }
}
