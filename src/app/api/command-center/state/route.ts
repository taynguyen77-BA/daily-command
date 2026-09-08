// V2.15 §2 — the Cross-Device Sync state endpoint. Unlike jira/sync/route.ts (whose data is
// entirely re-derivable from Jira and stays open when unconfigured), this synced slice is
// genuinely private — decision content, personal identity, interaction history — so both GET
// and POST require `Authorization: Bearer <APP_STATE_SECRET>`, and an UNCONFIGURED
// APP_STATE_SECRET means sync is treated as unavailable (503), never silently open. See
// checkAppStateAuth in ../../../../lib/command-center/app-state.ts for the pure decision this
// route just applies, and device-pairing.ts for how a browser comes to hold this secret (a
// one-time paste into that device's own localStorage — never a NEXT_PUBLIC_* env var, never
// bundled at build time).

import { NextResponse } from "next/server";
import { checkAppStateAuth, syncedAppStateSchema, type SyncedAppState } from "@/lib/command-center/app-state";
import { createAppStateStore, isAppStateStoreConfigured } from "@/lib/server/app-state-store";

export const runtime = "nodejs";
// Same reasoning as jira/status/route.ts and notify/route.ts's GET: without this, Next.js
// would statically optimize this route at build time and serve a frozen response forever.
export const dynamic = "force-dynamic";

function authorize(req: Request) {
  const auth = checkAppStateAuth(req.headers.get("authorization"), process.env.APP_STATE_SECRET);
  if (!auth.ok && auth.status === 503) {
    // §2 — "do not silently allow open access; log a clear warning" instead.
    console.warn("[command-center] APP_STATE_SECRET is not configured — Cross-Device Sync is unavailable on this deployment.");
  }
  return auth;
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!isAppStateStoreConfigured()) {
    return NextResponse.json({ ok: false, error: "Vercel KV is not configured on this server." }, { status: 503 });
  }
  const state = await createAppStateStore().get();
  return NextResponse.json({ ok: true, state });
}

export async function POST(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  if (!isAppStateStoreConfigured()) {
    return NextResponse.json({ ok: false, error: "Vercel KV is not configured on this server." }, { status: 503 });
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }
  const parsed = syncedAppStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Request did not match the expected shape." }, { status: 400 });
  }

  await createAppStateStore().set(parsed.data as unknown as SyncedAppState);
  return NextResponse.json({ ok: true });
}
