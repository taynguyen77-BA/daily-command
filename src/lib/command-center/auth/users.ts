// L3 — team members and their per-user settings, in KV:
//   daily-command:user:v1:<uid>          UserRecord (who, role, write permission, disabled)
//   daily-command:user-profile:v1:<uid>  UserProfile (Jira connection, Slack, notify, timezone)
//   daily-command:users:v1               set of uids (the team list)
//   daily-command:invites:v1             set of invited emails
// Secrets in a profile (Jira token, Slack webhook) are sealed with secret-box.ts and are never
// part of anything returned to a browser — publicProfile() is the only browser-facing view.

import type { KvLike } from "../kv/kv";
import { isAdminEmail, isEmailAllowed, normalizeEmail, userIdForEmail, type AuthSettings } from "./auth-config";

export type UserRole = "admin" | "member";

export interface UserRecord {
  uid: string;
  email: string;
  name?: string;
  role: UserRole;
  canWriteJira: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface JiraProfile {
  mode: "personal" | "shared" | "none";
  email?: string;
  tokenEnc?: string;
  accountId?: string;
  displayName?: string;
  verifiedAt?: string;
}

export interface SlackProfile {
  mode: "none" | "personal" | "team";
  webhookEnc?: string;
  channelLabel?: string;
}

export interface UserProfile {
  jira: JiraProfile;
  slack: SlackProfile;
  notifyEnabled: boolean;
  dailySnapshotEnabled: boolean;
  timezoneOffsetMinutes?: number;
}

export const DEFAULT_PROFILE: UserProfile = { jira: { mode: "none" }, slack: { mode: "none" }, notifyEnabled: false, dailySnapshotEnabled: false };

const USER_KEY = (uid: string) => `daily-command:user:v1:${uid}`;
const PROFILE_KEY = (uid: string) => `daily-command:user-profile:v1:${uid}`;
const USERS_SET = "daily-command:users:v1";
const INVITES_SET = "daily-command:invites:v1";

/** What a browser may see of a profile: no token, no webhook — only whether they exist. */
export interface PublicProfile {
  jira: { mode: JiraProfile["mode"]; connected: boolean; email?: string; accountId?: string; displayName?: string; verifiedAt?: string };
  slack: { mode: SlackProfile["mode"]; configured: boolean; channelLabel?: string };
  notifyEnabled: boolean;
  dailySnapshotEnabled: boolean;
  timezoneOffsetMinutes?: number;
}

export function publicProfile(p: UserProfile, opts: { teamSlackConfigured: boolean }): PublicProfile {
  return {
    jira: {
      mode: p.jira.mode,
      connected: p.jira.mode === "personal" ? !!p.jira.tokenEnc && !!p.jira.accountId : p.jira.mode === "shared" ? !!p.jira.accountId : false,
      ...(p.jira.email ? { email: p.jira.email } : {}),
      ...(p.jira.accountId ? { accountId: p.jira.accountId } : {}),
      ...(p.jira.displayName ? { displayName: p.jira.displayName } : {}),
      ...(p.jira.verifiedAt ? { verifiedAt: p.jira.verifiedAt } : {}),
    },
    slack: {
      mode: p.slack.mode,
      configured: p.slack.mode === "personal" ? !!p.slack.webhookEnc : p.slack.mode === "team" ? opts.teamSlackConfigured : false,
      ...(p.slack.channelLabel ? { channelLabel: p.slack.channelLabel } : {}),
    },
    notifyEnabled: p.notifyEnabled,
    dailySnapshotEnabled: p.dailySnapshotEnabled,
    ...(p.timezoneOffsetMinutes !== undefined ? { timezoneOffsetMinutes: p.timezoneOffsetMinutes } : {}),
  };
}

function asRecord(v: unknown, uid: string): UserRecord | null {
  const r = v as Partial<UserRecord> | null;
  if (!r || typeof r !== "object" || r.uid !== uid || typeof r.email !== "string" || (r.role !== "admin" && r.role !== "member")) return null;
  return { uid, email: r.email, name: typeof r.name === "string" ? r.name : undefined, role: r.role, canWriteJira: r.canWriteJira === true, disabled: r.disabled === true, createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(), lastLoginAt: typeof r.lastLoginAt === "string" ? r.lastLoginAt : undefined };
}

function asProfile(v: unknown): UserProfile {
  const p = (v && typeof v === "object" ? v : {}) as Partial<UserProfile>;
  const jira = (p.jira && typeof p.jira === "object" ? p.jira : {}) as Partial<JiraProfile>;
  const slack = (p.slack && typeof p.slack === "object" ? p.slack : {}) as Partial<SlackProfile>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return {
    jira: {
      mode: jira.mode === "personal" || jira.mode === "shared" ? jira.mode : "none",
      email: str(jira.email),
      tokenEnc: str(jira.tokenEnc),
      accountId: str(jira.accountId),
      displayName: str(jira.displayName),
      verifiedAt: str(jira.verifiedAt),
    },
    slack: { mode: slack.mode === "personal" || slack.mode === "team" ? slack.mode : "none", webhookEnc: str(slack.webhookEnc), channelLabel: str(slack.channelLabel) },
    notifyEnabled: p.notifyEnabled === true,
    dailySnapshotEnabled: p.dailySnapshotEnabled === true,
    timezoneOffsetMinutes: Number.isInteger(p.timezoneOffsetMinutes) && Math.abs(p.timezoneOffsetMinutes!) <= 14 * 60 ? p.timezoneOffsetMinutes : undefined,
  };
}

export type SignInDecision = { ok: true; user: UserRecord } | { ok: false; reason: "not-allowed" | "disabled" };

export type AdminUpdate = Partial<Pick<UserRecord, "role" | "canWriteJira" | "disabled">>;

export interface UserDirectory {
  getUser(uid: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  getProfile(uid: string): Promise<UserProfile>;
  setProfile(uid: string, profile: UserProfile): Promise<void>;
  listInvites(): Promise<string[]>;
  addInvite(email: string): Promise<void>;
  removeInvite(email: string): Promise<void>;
  /** The sign-in gate: allowed email, not disabled. Creates or refreshes the record. */
  signIn(email: string, name: string | undefined, settings: Pick<AuthSettings, "adminEmails" | "allowedEmails" | "allowedDomains">, now: Date): Promise<SignInDecision>;
  /** Admin changes, with the guards: AUTH_ADMIN_EMAILS members stay admin and enabled, and the
   *  last enabled admin can be neither demoted nor disabled. */
  adminUpdate(uid: string, patch: AdminUpdate, settings: Pick<AuthSettings, "adminEmails">): Promise<{ ok: true; user: UserRecord } | { ok: false; status: 400 | 404; error: string }>;
}

export function createUserDirectory(kv: KvLike): UserDirectory {
  const getUser = async (uid: string) => asRecord(await kv.get(USER_KEY(uid)), uid);
  const putUser = async (u: UserRecord) => {
    await kv.set(USER_KEY(u.uid), u);
    await kv.sadd(USERS_SET, u.uid);
  };
  const listUsers = async () => (await Promise.all((await kv.smembers(USERS_SET)).map(getUser))).filter((u): u is UserRecord => !!u).sort((a, b) => a.email.localeCompare(b.email));
  return {
    getUser,
    listUsers,
    getProfile: async (uid) => asProfile(await kv.get(PROFILE_KEY(uid))),
    setProfile: async (uid, profile) => kv.set(PROFILE_KEY(uid), profile),
    listInvites: async () => (await kv.smembers(INVITES_SET)).sort(),
    addInvite: async (email) => kv.sadd(INVITES_SET, normalizeEmail(email)),
    removeInvite: async (email) => kv.srem(INVITES_SET, normalizeEmail(email)),
    async signIn(email, name, settings, now) {
      const invites = (await kv.smembers(INVITES_SET)) ?? [];
      if (!isEmailAllowed(email, settings, invites)) return { ok: false, reason: "not-allowed" };
      const uid = userIdForEmail(email);
      const existing = await getUser(uid);
      if (existing?.disabled) return { ok: false, reason: "disabled" };
      const envAdmin = isAdminEmail(email, settings);
      const user: UserRecord = existing
        ? { ...existing, name: name || existing.name, role: envAdmin ? "admin" : existing.role, lastLoginAt: now.toISOString() }
        : { uid, email: normalizeEmail(email), name, role: envAdmin ? "admin" : "member", canWriteJira: envAdmin, disabled: false, createdAt: now.toISOString(), lastLoginAt: now.toISOString() };
      await putUser(user);
      return { ok: true, user };
    },
    async adminUpdate(uid, patch, settings) {
      const user = await getUser(uid);
      if (!user) return { ok: false, status: 404, error: "No such user." };
      const next: UserRecord = { ...user, ...(patch.role ? { role: patch.role } : {}), ...(patch.canWriteJira !== undefined ? { canWriteJira: patch.canWriteJira } : {}), ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}) };
      const losesAdmin = user.role === "admin" && !user.disabled && (next.role !== "admin" || next.disabled);
      if (losesAdmin && isAdminEmail(user.email, settings)) return { ok: false, status: 400, error: `${user.email} is in AUTH_ADMIN_EMAILS — always an enabled admin. Change the env var instead.` };
      if (losesAdmin) {
        const otherAdmins = (await listUsers()).filter((u) => u.uid !== uid && u.role === "admin" && !u.disabled);
        if (otherAdmins.length === 0) return { ok: false, status: 400, error: "This is the last admin — make someone else admin first." };
      }
      await putUser(next);
      return { ok: true, user: next };
    },
  };
}
