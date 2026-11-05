// D4 — GET: is server-side reminding active for this caller (+ the stored index, so the app can pull the cron's escalation progress)?
// POST: the client mirrors its compact ReminderIndex here (debounced) so the cron can remind with the app closed. Same auth as the notify
// prefs: paired bearer (sign-in off) or a signed-in member. Same-origin for writes. The index holds keys, states, dates and short titles only.

import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/command-center/auth/principal";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { asReminderIndex } from "@/lib/command-center/reminder-index";
import { storeClientIndex } from "@/lib/command-center/reminders-tick";
import { createReminderIndexStore } from "@/lib/server/reminder-index-store";
import { mirrorWho, noStore } from "@/lib/server/mirror-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_CHARS = 400_000;

export async function GET(req: Request) {
  const w = await mirrorWho(req);
  if (!w.ok) return w.res;
  let index = null;
  if (isNotifyStoreConfigured()) {
    try { index = await createReminderIndexStore(w.uid).get(); } catch { index = null; }
  }
  return NextResponse.json({ ok: true, active: w.active, kvConfigured: isNotifyStoreConfigured(), index }, { headers: noStore });
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
  const index = asReminderIndex((raw as { index?: unknown } | null)?.index);
  if (!index) return NextResponse.json({ ok: false, error: "Not a reminder index." }, { status: 400, headers: noStore });
  try {
    const merged = await storeClientIndex(createReminderIndexStore(w.uid), index);
    return NextResponse.json({ ok: true, saved: true, items: merged.items.length, active: w.active }, { headers: noStore });
  } catch {
    return NextResponse.json({ ok: false, saved: false, reason: "kv-unavailable" }, { status: 503, headers: noStore });
  }
}
