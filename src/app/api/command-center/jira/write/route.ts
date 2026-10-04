// F4/G2 — the only route that writes to Jira. The server gate (jira/write-gate.ts) decides:
// JIRA_WRITE_ENABLED=true, the issue's project in JIRA_WRITE_PROJECT_KEYS, and
// `Authorization: Bearer <JIRA_WRITE_SECRET>` (never CRON_SECRET / APP_STATE_SECRET for a
// write), rate limited per instance, every outcome logged in KV. GET returns the gate's status
// (and, to a paired device, the allowed projects and the server log) for Data & Settings and
// Setup Health.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getJiraConfig } from "@/lib/server/jira-client";
import { createJiraWriteLogStore } from "@/lib/server/jira-write-log-store";
import { HttpJiraActionProvider } from "@/lib/command-center/jira/jira-action-provider";
import { createPerUserRateLimiters, createWriteRateLimiter, handleJiraWriteRequest, readJiraWriteConfig } from "@/lib/command-center/jira/write-gate";
import { bearerMatches } from "@/lib/command-center/secure-compare";
import type { UserRecord } from "@/lib/command-center/auth/users";
import { principalError, principalJira, requestPrincipal, userProfile } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("comment"), issueKey, text: z.string().min(1).max(30_000) }), // V2.38 — requirement checks can be long (Jira allows ~32k)
  z.object({ action: z.literal("flag"), issueKey, fieldId: z.string().regex(/^customfield_\d{1,9}$/) }),
  z.object({ action: z.literal("transition"), issueKey, transitionId: z.string().regex(/^\d{1,9}$/) }),
  z.object({ action: z.literal("list-transitions"), issueKey }),
]);

// One limiter per server instance (module scope survives across requests on a warm instance).
const limiter = createWriteRateLimiter();
// L4 — sign-in on: one limiter per member.
const memberLimiter = createPerUserRateLimiters();

/** L4 — sign-in on: the member writes with their OWN Jira connection, if an admin allowed them
 *  (canWriteJira); shared Jira is read-only. No JIRA_WRITE_SECRET; their own log and limit. */
async function memberWrite(req: Request, user: UserRecord) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) return NextResponse.json({ ok: false, error: "Request did not match the expected shape." }, { status: 400 });
  const jira = await principalJira({ kind: "user", user });
  const jiraMode = (await userProfile(user.uid)).jira.mode;
  if (!jira.ok) return NextResponse.json({ ok: false, error: jira.error }, { status: 403 });
  const result = await handleJiraWriteRequest(body.data, null, {
    env: process.env,
    provider: new HttpJiraActionProvider(fetch, jira.config),
    limiter: memberLimiter(user.uid),
    log: createJiraWriteLogStore(user.uid),
    now: () => new Date(),
    member: { uid: user.uid, email: user.email, canWriteJira: user.canWriteJira, jiraMode },
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(req: Request) {
  const p = await requestPrincipal(req, { legacyCheck: "open" });
  if (p.kind === "error") return principalError(p);
  if (p.kind === "user") return memberWrite(req, p.user);
  const config = getJiraConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Jira is not configured on the server." }, { status: 503 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Request did not match the expected shape." }, { status: 400 });
  const result = await handleJiraWriteRequest(parsed.data, req.headers.get("authorization"), {
    env: process.env,
    provider: new HttpJiraActionProvider(fetch, config),
    limiter,
    log: createJiraWriteLogStore(),
    now: () => new Date(),
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(req: Request) {
  const p = await requestPrincipal(req, { legacyCheck: "open" });
  if (p.kind === "error") return principalError(p);
  if (p.kind === "user") {
    const memberGate = readJiraWriteConfig(process.env, { requireSecret: false });
    const mode = (await userProfile(p.user.uid)).jira.mode;
    return NextResponse.json({ enabled: memberGate.enabled, missing: memberGate.missing, projectKeys: memberGate.projectKeys, writePaired: p.user.canWriteJira && mode === "personal", canWriteJira: p.user.canWriteJira, jiraMode: mode, log: await createJiraWriteLogStore(p.user.uid).list(50) });
  }
  const gate = readJiraWriteConfig(process.env);
  const auth = req.headers.get("authorization");
  const paired = bearerMatches(auth, process.env.JIRA_WRITE_SECRET?.trim()) || bearerMatches(auth, process.env.APP_STATE_SECRET?.trim());
  const writePaired = bearerMatches(auth, process.env.JIRA_WRITE_SECRET?.trim());
  return NextResponse.json({
    enabled: gate.enabled,
    missing: gate.missing,
    ...(paired ? { projectKeys: gate.projectKeys, writePaired, log: await createJiraWriteLogStore().list(50) } : {}),
  });
}
