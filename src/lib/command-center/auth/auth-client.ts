// L5/L6 — the browser side of team sign-in: what /api/command-center/me returns, and the calls
// Data & Settings makes. Browser-safe (no Node imports). Requests carry the session cookie —
// never a pairing secret (device-pairing.ts sends none in session mode).

import type { PersonalIdentity } from "../types";

export interface MeUser {
  uid: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  canWriteJira: boolean;
}

export interface MeProfile {
  jira: { mode: "personal" | "shared" | "none"; connected: boolean; email?: string; accountId?: string; displayName?: string; verifiedAt?: string };
  slack: { mode: "none" | "personal" | "team"; configured: boolean; channelLabel?: string };
  notifyEnabled: boolean;
  dailySnapshotEnabled: boolean;
  timezoneOffsetMinutes?: number;
}

export interface Me {
  user: MeUser;
  profile: MeProfile;
  options: { allowSharedJira: boolean; teamSlackConfigured: boolean; teamSlackLabel?: string; jiraHost?: string };
  adoptLegacyData: boolean;
}

export type MeLoad = { kind: "off" } | { kind: "signed-in"; me: Me } | { kind: "signed-out" } | { kind: "misconfigured"; error: string; missing: string[] } | { kind: "error"; error: string };

const ME = "/api/command-center/me";

export async function loadMe(): Promise<MeLoad> {
  try {
    const res = await fetch(ME, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as Partial<Me> & { ok?: boolean; authEnabled?: boolean; error?: string; missing?: string[] };
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 503) return { kind: "misconfigured", error: json.error ?? "Sign-in is not fully configured.", missing: json.missing ?? [] };
    if (!res.ok) return { kind: "error", error: json.error ?? `HTTP ${res.status}` };
    if (json.authEnabled === false) return { kind: "off" };
    return { kind: "signed-in", me: { user: json.user!, profile: json.profile!, options: json.options!, adoptLegacyData: json.adoptLegacyData === true } };
  } catch {
    return { kind: "error", error: "Couldn't reach the server." };
  }
}

/** The identity the app should hold for this member: their Jira name and accountId from their
 *  verified connection. null when the stored identity already matches (nothing to change). */
export function identityFromMe(current: PersonalIdentity | undefined, me: Me): { displayName: string; email?: string; accountId?: string } | null {
  const accountId = me.profile.jira.accountId;
  const displayName = me.profile.jira.displayName || current?.displayName || me.user.name || me.user.email;
  if (!accountId) return null;
  if (current?.accountId === accountId && current.displayName === displayName) return null;
  return { displayName, email: current?.email ?? me.user.email, accountId };
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, method: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    return res.ok && json.ok !== false ? { ok: true, data: json } : { ok: false, error: json.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

type MeBody = Pick<Me, "user" | "profile" | "options" | "adoptLegacyData">;

export const updateMe = (patch: Record<string, unknown>) => call<MeBody>(ME, "PATCH", patch);
export const connectJira = (email: string, apiToken: string) => call<MeBody>(`${ME}/jira`, "POST", { email, apiToken });
export const disconnectJira = () => call<MeBody>(`${ME}/jira`, "DELETE");
export const testSlack = () => call<{ ok: boolean }>(`${ME}/slack-test`, "POST");

export interface TeamUserRow {
  uid: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  canWriteJira: boolean;
  disabled: boolean;
  lastLoginAt?: string;
  jiraMode: "personal" | "shared" | "none";
  jiraConnected: boolean;
  envAdmin: boolean;
}
export type TeamBody = { users: TeamUserRow[]; invites: string[] };

export const loadTeam = () => call<TeamBody>("/api/command-center/admin/users", "GET");
export const updateTeamUser = (uid: string, patch: { role?: "admin" | "member"; canWriteJira?: boolean; disabled?: boolean }) => call<TeamBody>("/api/command-center/admin/users", "PATCH", { uid, ...patch });
export const addInvite = (email: string) => call<TeamBody>("/api/command-center/admin/invites", "POST", { email });
export const removeInvite = (email: string) => call<TeamBody>("/api/command-center/admin/invites", "DELETE", { email });
