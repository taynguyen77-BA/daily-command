// G2 — the SERVER-side gate for Jira write-back. The client feature switch and allow-list
// (write-back.ts) decide what the app offers; this decides what the server will actually send to
// Jira, whatever any browser asks for:
//   JIRA_WRITE_ENABLED       must be "true" (anything else → 503, regardless of the client)
//   JIRA_WRITE_PROJECT_KEYS  comma list, required when enabled; an issue outside it → 403
//   JIRA_WRITE_SECRET        its own secret (never CRON_SECRET, never APP_STATE_SECRET) as
//                            `Authorization: Bearer …`, compared in constant time → else 401.
//                            Paired per device like APP_STATE_SECRET, kept in that device's
//                            localStorage only (device-pairing.ts).
// "list-transitions" only reads, so it also accepts the APP_STATE_SECRET pairing.
// Writes are rate limited per server instance (30/hour by default) and every outcome past
// authentication is appended to the server log (no comment text beyond 200 characters).
//
// L4 — team sign-in on: the caller is a signed-in member instead of a paired device. The
// member needs canWriteJira (set by an admin) and their OWN Jira connection (shared Jira is
// read-only); JIRA_WRITE_SECRET is not required; the rate limit and the log are per member
// (the route passes that member's limiter and log), and log entries carry uid/email.
//
// Pure: env, the provider, the limiter, the log and the clock are injected — the route
// (api/command-center/jira/write) is a thin wrapper, and every rule here is tested offline.

import { bearerMatches } from "../secure-compare";
import { performJiraWrite, type JiraWriteRequest } from "./write-back";
import { projectKeyOf } from "./write-back";
import type { JiraActionProvider } from "./jira-action-provider";

export type JiraWriteGateEnv = Record<string, string | undefined>;

export interface JiraWriteServerConfig {
  enabled: boolean;
  projectKeys: string[];
  secretConfigured: boolean;
  /** The exact variables still missing for writes to work (empty = ready). */
  missing: string[];
}

export function readJiraWriteConfig(env: JiraWriteGateEnv, opts: { requireSecret?: boolean } = {}): JiraWriteServerConfig {
  const requireSecret = opts.requireSecret ?? true;
  const enabled = env.JIRA_WRITE_ENABLED?.trim().toLowerCase() === "true";
  const projectKeys = Array.from(new Set((env.JIRA_WRITE_PROJECT_KEYS ?? "").split(",").map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k))));
  const secretConfigured = !!env.JIRA_WRITE_SECRET?.trim();
  const missing = [...(!enabled ? ["JIRA_WRITE_ENABLED=true"] : []), ...(projectKeys.length === 0 ? ["JIRA_WRITE_PROJECT_KEYS"] : []), ...(requireSecret && !secretConfigured ? ["JIRA_WRITE_SECRET"] : [])];
  return { enabled, projectKeys, secretConfigured, missing };
}

// ===== Rate limit (per server instance) ==================================================

export const JIRA_WRITE_RATE_LIMIT = 30;
export const JIRA_WRITE_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface WriteRateLimiter {
  /** Records one write if under the limit; false when the limit is reached. */
  tryTake(nowMs: number): boolean;
}

/** L4 — one limiter per member (sign-in on), created on first use. */
export function createPerUserRateLimiters(limit = JIRA_WRITE_RATE_LIMIT, windowMs = JIRA_WRITE_RATE_WINDOW_MS): (uid: string) => WriteRateLimiter {
  const byUser = new Map<string, WriteRateLimiter>();
  return (uid) => {
    let l = byUser.get(uid);
    if (!l) byUser.set(uid, (l = createWriteRateLimiter(limit, windowMs)));
    return l;
  };
}

export function createWriteRateLimiter(limit = JIRA_WRITE_RATE_LIMIT, windowMs = JIRA_WRITE_RATE_WINDOW_MS): WriteRateLimiter {
  const stamps: number[] = [];
  return {
    tryTake(nowMs) {
      while (stamps.length > 0 && stamps[0] <= nowMs - windowMs) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(nowMs);
      return true;
    },
  };
}

// ===== Server log (append-only) ==========================================================

export const JIRA_WRITE_LOG_DETAIL_MAX = 200;

export interface JiraWriteServerLogEntry {
  at: string;
  issueKey: string;
  action: "comment" | "flag" | "transition";
  outcome: "ok" | "failed" | "forbidden" | "rate-limited";
  /** Comment text (≤200 chars), flag field, or transition id; Jira's error on failure. */
  detail?: string;
  /** L4 — the signed-in member who asked (team sign-in on). */
  uid?: string;
  email?: string;
}

export interface JiraWriteLogStore {
  append(entry: JiraWriteServerLogEntry): Promise<void>;
  list(limit: number): Promise<JiraWriteServerLogEntry[]>;
}

export function createInMemoryJiraWriteLog(): JiraWriteLogStore & { entries: JiraWriteServerLogEntry[] } {
  const entries: JiraWriteServerLogEntry[] = [];
  return {
    entries,
    async append(e) {
      entries.push({ ...e });
    },
    async list(limit) {
      return entries.slice(-limit).reverse();
    },
  };
}

const clip = (s: string) => (s.length > JIRA_WRITE_LOG_DETAIL_MAX ? `${s.slice(0, JIRA_WRITE_LOG_DETAIL_MAX - 1)}…` : s);

function detailOf(req: JiraWriteRequest): string {
  return clip(req.action === "comment" ? req.text : req.action === "flag" ? req.fieldId : `transition ${req.transitionId}`);
}

// ===== The request handler ===============================================================

export type JiraWriteGateRequest = JiraWriteRequest | { action: "list-transitions"; issueKey: string };

export interface JiraWriteGateDeps {
  env: JiraWriteGateEnv;
  provider: Pick<JiraActionProvider, "addComment" | "updateIssue" | "transitionIssue" | "listTransitions">;
  limiter: WriteRateLimiter;
  log: JiraWriteLogStore;
  now: () => Date;
  /** L4 — team sign-in: the signed-in member (replaces the JIRA_WRITE_SECRET pairing). */
  member?: { uid: string; email: string; canWriteJira: boolean; jiraMode: "personal" | "shared" | "none" };
}

export async function handleJiraWriteRequest(req: JiraWriteGateRequest, authorization: string | null, deps: JiraWriteGateDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const member = deps.member;
  const config = readJiraWriteConfig(deps.env, { requireSecret: !member });
  if (config.missing.length > 0) {
    return { status: 503, body: { ok: false, error: `Jira write-back is not enabled on this server (missing: ${config.missing.join(", ")}).`, missing: config.missing } };
  }
  const isWrite = req.action !== "list-transitions";
  if (member) {
    if (member.jiraMode === "none") return { status: 403, body: { ok: false, error: "Connect your Jira account first (Data & Settings → My account)." } };
    if (isWrite && member.jiraMode !== "personal") return { status: 403, body: { ok: false, error: "Shared Jira access is read-only — connect your own Jira account to write." } };
    if (isWrite && !member.canWriteJira) return { status: 403, body: { ok: false, error: "Your account isn't allowed to write to Jira — ask an admin." } };
  } else {
    const writeSecret = deps.env.JIRA_WRITE_SECRET!.trim();
    const authorized = bearerMatches(authorization, writeSecret) || (!isWrite && bearerMatches(authorization, deps.env.APP_STATE_SECRET?.trim()));
    if (!authorized) {
      return { status: 401, body: { ok: false, error: isWrite ? "Writes need this device paired with JIRA_WRITE_SECRET (Data & Settings → Jira write-back)." : "Pair this device first." } };
    }
  }
  const who = member ? { uid: member.uid, email: member.email } : {};
  const project = projectKeyOf(req.issueKey);
  const at = deps.now().toISOString();
  if (!project || !config.projectKeys.includes(project)) {
    if (isWrite) await deps.log.append({ at, issueKey: req.issueKey, action: req.action, outcome: "forbidden", ...who });
    return { status: 403, body: { ok: false, error: `${project ?? req.issueKey} is not in this server's JIRA_WRITE_PROJECT_KEYS.` } };
  }
  if (!isWrite) {
    const r = await performJiraWrite(deps.provider, req);
    return { status: r.ok ? 200 : 502, body: r };
  }
  if (!deps.limiter.tryTake(deps.now().getTime())) {
    await deps.log.append({ at, issueKey: req.issueKey, action: req.action, outcome: "rate-limited", ...who });
    return { status: 429, body: { ok: false, error: `Rate limit: at most ${JIRA_WRITE_RATE_LIMIT} Jira writes per hour ${member ? "per member" : "on this server"}.` } };
  }
  const r = await performJiraWrite(deps.provider, req);
  await deps.log.append({ at, issueKey: req.issueKey, action: req.action, outcome: r.ok ? "ok" : "failed", detail: r.ok ? detailOf(req) : clip(r.error), ...who });
  return { status: r.ok ? 200 : 502, body: r };
}
