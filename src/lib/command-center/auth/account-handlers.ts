// L3/L6 — what /api/command-center/me[/jira|/slack-test] and /api/command-center/admin/* do,
// as pure handlers (the routes only resolve the signed-in user and wire env, KV and fetch in).
// Nothing here ever returns a token, a webhook or a ciphertext: responses carry publicProfile()
// only. Admin handlers answer 403 to members.

import { z } from "zod";
import type { FetchLike } from "../jira/http";
import { isEmailShaped, normalizeEmail, type AuthSettings, type Env } from "./auth-config";
import { JIRA_ACCOUNT_ID_RE, serverJiraBaseUrl, serverJiraConfig, slackWebhookForUser, SLACK_WEBHOOK_RE, verifyJiraCredentials } from "./connections";
import { encryptSecret } from "./secret-box";
import { publicProfile, type UserDirectory, type UserProfile, type UserRecord } from "./users";

export interface AccountContext {
  user: UserRecord;
  directory: UserDirectory;
  env: Env;
  settings: AuthSettings;
  key: Buffer | null;
  now: () => Date;
}

export type HandlerResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string): HandlerResult => ({ status, body: { ok: false, error } });
const teamSlackConfigured = (env: Env) => !!env.SLACK_WEBHOOK_URL?.trim();

async function meBody(ctx: AccountContext, profile?: UserProfile): Promise<Record<string, unknown>> {
  const p = profile ?? (await ctx.directory.getProfile(ctx.user.uid));
  let jiraHost: string | undefined;
  try {
    jiraHost = serverJiraBaseUrl(ctx.env) ? new URL(serverJiraBaseUrl(ctx.env)!).host : undefined;
  } catch {
    jiraHost = undefined;
  }
  return {
    ok: true,
    authEnabled: true,
    user: { uid: ctx.user.uid, email: ctx.user.email, name: ctx.user.name, role: ctx.user.role, canWriteJira: ctx.user.canWriteJira },
    profile: publicProfile(p, { teamSlackConfigured: teamSlackConfigured(ctx.env) }),
    options: {
      allowSharedJira: ctx.settings.allowSharedJira && !!serverJiraConfig(ctx.env),
      teamSlackConfigured: teamSlackConfigured(ctx.env),
      teamSlackLabel: ctx.env.SLACK_CHANNEL_LABEL?.trim() || undefined,
      jiraHost,
    },
    // L5 — only this one person's browser may take over the pre-sign-in local data.
    adoptLegacyData: !!ctx.settings.legacyDataOwner && normalizeEmail(ctx.user.email) === ctx.settings.legacyDataOwner,
  };
}

export async function handleMeGet(ctx: AccountContext): Promise<HandlerResult> {
  return { status: 200, body: await meBody(ctx) };
}

const mePatchSchema = z
  .object({
    slack: z.object({ mode: z.enum(["none", "personal", "team"]), webhookUrl: z.string().max(300).optional(), channelLabel: z.string().max(80).optional() }).optional(),
    jira: z.object({ mode: z.literal("shared"), accountId: z.string() }).optional(),
    notifyEnabled: z.boolean().optional(),
    dailySnapshotEnabled: z.boolean().optional(),
    timezoneOffsetMinutes: z.number().int().min(-14 * 60).max(14 * 60).nullable().optional(),
  })
  .strict();

export async function handleMePatch(ctx: AccountContext, body: unknown): Promise<HandlerResult> {
  const parsed = mePatchSchema.safeParse(body);
  if (!parsed.success) return fail(400, "Request did not match the expected shape.");
  const patch = parsed.data;
  const profile = await ctx.directory.getProfile(ctx.user.uid);
  const next: UserProfile = { ...profile, jira: { ...profile.jira }, slack: { ...profile.slack } };
  if (patch.slack) {
    const label = patch.slack.channelLabel?.trim() || undefined;
    if (patch.slack.mode === "personal") {
      const url = patch.slack.webhookUrl?.trim();
      if (url) {
        if (!SLACK_WEBHOOK_RE.test(url)) return fail(400, "That isn't a Slack incoming-webhook URL (https://hooks.slack.com/services/…).");
        if (!ctx.key) return fail(503, "The server can't encrypt secrets (NEXTAUTH_SECRET / AUTH_ENCRYPTION_KEY).");
        next.slack = { mode: "personal", webhookEnc: encryptSecret(url, ctx.key, ctx.user.uid), channelLabel: label };
      } else if (profile.slack.mode === "personal" && profile.slack.webhookEnc) {
        next.slack = { ...profile.slack, channelLabel: label }; // keep the stored webhook
      } else return fail(400, "Paste your Slack incoming-webhook URL.");
    } else if (patch.slack.mode === "team") {
      if (!teamSlackConfigured(ctx.env)) return fail(400, "The server has no team Slack channel (SLACK_WEBHOOK_URL).");
      next.slack = { mode: "team" };
    } else next.slack = { mode: "none" };
  }
  if (patch.jira) {
    if (!ctx.settings.allowSharedJira || !serverJiraConfig(ctx.env)) return fail(403, "Shared Jira access is off on this server (AUTH_ALLOW_SHARED_JIRA).");
    const accountId = patch.jira.accountId.trim();
    if (!JIRA_ACCOUNT_ID_RE.test(accountId)) return fail(400, "That doesn't look like a Jira accountId.");
    next.jira = { mode: "shared", accountId };
  }
  if (patch.notifyEnabled !== undefined) next.notifyEnabled = patch.notifyEnabled;
  if (patch.dailySnapshotEnabled !== undefined) next.dailySnapshotEnabled = patch.dailySnapshotEnabled;
  if (patch.timezoneOffsetMinutes !== undefined) next.timezoneOffsetMinutes = patch.timezoneOffsetMinutes ?? undefined;
  await ctx.directory.setProfile(ctx.user.uid, next);
  return { status: 200, body: await meBody(ctx, next) };
}

const connectSchema = z.object({ email: z.string().max(254), apiToken: z.string().min(1).max(2000) }).strict();

/** Verify against the server's JIRA_BASE_URL (/myself), then keep the token encrypted. */
export async function handleJiraConnect(ctx: AccountContext, body: unknown, fetchImpl: FetchLike): Promise<HandlerResult> {
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success || !isEmailShaped(parsed.data.email)) return fail(400, "Send your Atlassian account email and an API token.");
  const baseUrl = serverJiraBaseUrl(ctx.env);
  if (!baseUrl) return fail(503, "Jira is not configured on the server (JIRA_BASE_URL).");
  if (!ctx.key) return fail(503, "The server can't encrypt secrets (NEXTAUTH_SECRET / AUTH_ENCRYPTION_KEY).");
  const email = parsed.data.email.trim();
  const apiToken = parsed.data.apiToken.trim();
  const verified = await verifyJiraCredentials(fetchImpl, baseUrl, email, apiToken);
  if (!verified.ok) return fail(verified.status, verified.error);
  const profile = await ctx.directory.getProfile(ctx.user.uid);
  const next: UserProfile = { ...profile, jira: { mode: "personal", email, tokenEnc: encryptSecret(apiToken, ctx.key, ctx.user.uid), accountId: verified.accountId, displayName: verified.displayName, verifiedAt: ctx.now().toISOString() } };
  await ctx.directory.setProfile(ctx.user.uid, next);
  return { status: 200, body: await meBody(ctx, next) };
}

export async function handleJiraDisconnect(ctx: AccountContext): Promise<HandlerResult> {
  const profile = await ctx.directory.getProfile(ctx.user.uid);
  const next: UserProfile = { ...profile, jira: { mode: "none" } };
  await ctx.directory.setProfile(ctx.user.uid, next);
  return { status: 200, body: await meBody(ctx, next) };
}

export async function handleSlackTest(ctx: AccountContext, post: (webhookUrl: string, text: string) => Promise<{ ok: boolean }>): Promise<HandlerResult> {
  const webhook = slackWebhookForUser(ctx.user.uid, await ctx.directory.getProfile(ctx.user.uid), ctx.env, ctx.key);
  if (!webhook) return fail(400, "No Slack destination set for your account.");
  const r = await post(webhook, `✅ Daily Command test notification for ${ctx.user.email}.`);
  return { status: r.ok ? 200 : 502, body: { ok: r.ok, ...(r.ok ? {} : { error: "Slack didn't accept the message." }) } };
}

// ===== Admin =================================================================================

const notAdmin = (ctx: AccountContext) => ctx.user.role !== "admin";

export async function handleAdminUsersGet(ctx: AccountContext): Promise<HandlerResult> {
  if (notAdmin(ctx)) return fail(403, "Admins only.");
  const users = await ctx.directory.listUsers();
  const rows = await Promise.all(
    users.map(async (u) => {
      const p = publicProfile(await ctx.directory.getProfile(u.uid), { teamSlackConfigured: teamSlackConfigured(ctx.env) });
      return { uid: u.uid, email: u.email, name: u.name, role: u.role, canWriteJira: u.canWriteJira, disabled: u.disabled, lastLoginAt: u.lastLoginAt, jiraMode: p.jira.mode, jiraConnected: p.jira.connected, envAdmin: ctx.settings.adminEmails.includes(u.email) };
    })
  );
  return { status: 200, body: { ok: true, users: rows, invites: await ctx.directory.listInvites() } };
}

const adminPatchSchema = z.object({ uid: z.string(), role: z.enum(["admin", "member"]).optional(), canWriteJira: z.boolean().optional(), disabled: z.boolean().optional() }).strict();

export async function handleAdminUsersPatch(ctx: AccountContext, body: unknown): Promise<HandlerResult> {
  if (notAdmin(ctx)) return fail(403, "Admins only.");
  const parsed = adminPatchSchema.safeParse(body);
  if (!parsed.success) return fail(400, "Request did not match the expected shape.");
  const { uid, ...patch } = parsed.data;
  const r = await ctx.directory.adminUpdate(uid, patch, ctx.settings);
  return r.ok ? handleAdminUsersGet(ctx) : fail(r.status, r.error);
}

const inviteSchema = z.object({ email: z.string().max(254) }).strict();

export async function handleInvite(ctx: AccountContext, body: unknown, action: "add" | "remove"): Promise<HandlerResult> {
  if (notAdmin(ctx)) return fail(403, "Admins only.");
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success || !isEmailShaped(parsed.data.email)) return fail(400, "Send a valid email address.");
  if (action === "add") await ctx.directory.addInvite(parsed.data.email);
  else await ctx.directory.removeInvite(parsed.data.email);
  return handleAdminUsersGet(ctx);
}
