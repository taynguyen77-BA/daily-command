// V2.40 — team sign-in (L1–L7). Opt-in: with AUTH_ENABLED unset nothing changes (the rest of
// this suite runs unchanged against that default). Everything here runs offline against the
// real decision code: auth-config, principal resolution, the user directory, the encrypted
// connections, the per-user KV stores on ONE shared in-memory KV, the write gate, the per-member
// cron, the per-user AI cap and the per-user browser store on ONE shared device backend.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";
import { isAdminEmail, isEmailAllowed, misconfigurationError, PROVIDER_REQUIREMENT, readAuthSettings, scopedKey, sessionCookieConfig, userIdForEmail } from "../../src/lib/command-center/auth/auth-config";
import { effectiveAccountId, isSameOrigin, resolvePrincipal } from "../../src/lib/command-center/auth/principal";
import { createUserDirectory, type UserRecord } from "../../src/lib/command-center/auth/users";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../../src/lib/command-center/auth/secret-box";
import { jiraConfigForUser, slackWebhookForUser } from "../../src/lib/command-center/auth/connections";
import { handleAdminUsersGet, handleAdminUsersPatch, handleInvite, handleJiraConnect, handleJiraDisconnect, handleMeGet, handleMePatch, type AccountContext } from "../../src/lib/command-center/auth/account-handlers";
import { planCronMembers } from "../../src/lib/command-center/auth/cron-plan";
import { identityFromMe, type Me } from "../../src/lib/command-center/auth/auth-client";
import { checkSyncRequestAuth } from "../../src/lib/command-center/jira/sync-auth";
import { checkAppStateAuth } from "../../src/lib/command-center/app-state";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv";
import { createKvAppStateStore, createKvJiraWriteLogStore, createKvNotifyStore, createKvServerReportStore, APP_STATE_KEY } from "../../src/lib/command-center/kv/kv-stores";
import { createInMemoryJiraWriteLog, createPerUserRateLimiters, handleJiraWriteRequest, readJiraWriteConfig, type JiraWriteGateRequest } from "../../src/lib/command-center/jira/write-gate";
import { HttpJiraActionProvider } from "../../src/lib/command-center/jira/jira-action-provider";
import { runCronForMembers } from "../../src/lib/command-center/jira/cron-tick";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import { createInMemoryServerReportStore } from "../../src/lib/command-center/server-daily-report";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { handleAiRequest, ResponseCache, type ModelCallParams, type ModelCallResult } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger, recordsOfUser, resolveUserDailyTokenCap, summarizeUsage } from "../../src/lib/command-center/ai/usage-ledger";
import { CommandCenterStore, userStorageKey } from "../../src/lib/command-center/store";
import { createMemoryKeyedBackend, createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { isDevicePaired, jiraWriteAuthHeader, pairedAuthHeader, setSessionAuthMode } from "../../src/lib/command-center/device-pairing";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { emptyData } from "../../src/lib/command-center/types";
import { initAppStateSync, resetAppStateSyncForNewPairing } from "../../src/lib/command-center/app-state-sync";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 20));

const ADMIN = "lead@acme.com";
const ENV_ON = {
  AUTH_ENABLED: "true",
  NEXTAUTH_SECRET: "test-nextauth-secret-0123456789abcdef",
  AUTH_DEV_LOGIN: "true",
  AUTH_ADMIN_EMAILS: ADMIN,
  AUTH_ALLOWED_DOMAINS: "acme.com",
  JIRA_BASE_URL: "https://acme.atlassian.net",
  CRON_SECRET: "cron-s3cret",
  APP_STATE_SECRET: "app-s3cret",
  JIRA_WRITE_SECRET: "write-s3cret",
  NODE_ENV: "test",
};
const settingsOn = readAuthSettings(ENV_ON);
const KEY = resolveEncryptionKey(ENV_ON)!;
const NOW = new Date("2026-10-07T11:00:00.000Z");
const userRec = (email: string, over: Partial<UserRecord> = {}): UserRecord => ({ uid: userIdForEmail(email), email, role: "member", canWriteJira: false, disabled: false, createdAt: NOW.toISOString(), ...over });

// ===== L1 — opt-in and configuration =====
{
  const group = "L1 Auth config";
  const off = readAuthSettings({});
  ok(group, !off.enabled && off.missing.length === 0 && !readAuthSettings({ AUTH_ENABLED: "yes" }).enabled, "AUTH_ENABLED unset (or anything but 'true') → sign-in off, nothing missing");
  ok(group, settingsOn.enabled && settingsOn.missing.length === 0 && settingsOn.providers.dev, "a complete config (secret, dev login, admin) is accepted");
  const bare = readAuthSettings({ AUTH_ENABLED: "true" });
  ok(group, bare.missing.includes("NEXTAUTH_SECRET") && bare.missing.includes(PROVIDER_REQUIREMENT) && bare.missing.includes("AUTH_ADMIN_EMAILS"), `enabled with nothing → names each missing piece (${bare.missing.length})`);
  const prod = readAuthSettings({ ...ENV_ON, NODE_ENV: "production" });
  ok(group, !prod.providers.dev && prod.missing.includes(PROVIDER_REQUIREMENT) && prod.missing.some((m) => m.startsWith("KV_REST_API_URL")), "production: the dev login never counts as a provider, and KV is required");
  const half = readAuthSettings({ ...ENV_ON, GOOGLE_CLIENT_ID: "x" });
  ok(group, half.missing.includes("GOOGLE_CLIENT_SECRET"), "a half-configured provider names its missing variable");
  ok(group, readAuthSettings({ ...ENV_ON, AUTH_ENCRYPTION_KEY: "short" }).missing.some((m) => m.startsWith("AUTH_ENCRYPTION_KEY")), "an invalid AUTH_ENCRYPTION_KEY fails closed");
  ok(group, readAuthSettings({ ...ENV_ON, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", AZURE_AD_CLIENT_ID: "a", AZURE_AD_CLIENT_SECRET: "b", AZURE_AD_TENANT_ID: "t", ATLASSIAN_CLIENT_ID: "c", ATLASSIAN_CLIENT_SECRET: "d" }).providers.azureAd, "providers are enabled by env presence");

  ok(group, isEmailAllowed(ADMIN, settingsOn) && isEmailAllowed("dev@ACME.com", settingsOn) && !isEmailAllowed("x@evil.com", settingsOn) && isEmailAllowed("guest@partner.io", settingsOn, ["Guest@Partner.io"]) && !isEmailAllowed("not-an-email", settingsOn), "admins, listed domains and invites may sign in; nobody else");
  ok(group, isAdminEmail("LEAD@acme.com", settingsOn) && !isAdminEmail("dev@acme.com", settingsOn), "AUTH_ADMIN_EMAILS (case-insensitive) are admins");
  const uid = userIdForEmail("Dev@Acme.com ");
  ok(group, /^u_[0-9a-f]{24}$/.test(uid) && uid === userIdForEmail("dev@acme.com") && uid !== userIdForEmail("dev2@acme.com"), "user id = u_ + sha256(daily-command:email)[0:24]; same email (any case, any provider) → same id");
  ok(group, scopedKey("k") === "k" && scopedKey("k", uid) === `k:u:${uid}`, "scopedKey: no uid → exactly the single-user key; a uid → a per-user key");
  let threw = false;
  try {
    scopedKey("k", "../other");
  } catch {
    threw = true;
  }
  ok(group, threw, "a malformed uid never builds a key");
  const cookie = sessionCookieConfig({ NODE_ENV: "production" });
  ok(group, cookie.options.httpOnly && cookie.options.sameSite === "lax" && cookie.secure && cookie.name.startsWith("__Secure-") && !sessionCookieConfig({ NODE_ENV: "development" }).secure, "L7 session cookie: httpOnly, sameSite=lax, secure in production");

  const layout = read("src/app/layout.tsx");
  ok(group, /authEnabled \? \(\s*<AuthGate/.test(layout) && /process\.env\.AUTH_ENABLED/.test(layout), "the layout mounts AuthGate only when AUTH_ENABLED=true — off, the app renders exactly as before");
  const mw = read("src/proxy.ts"); // Next 16: middleware.ts → proxy.ts
  ok(group, /AUTH_ENABLED[\s\S]*return NextResponse\.next\(\)/.test(mw) && /api\/\|_next\/\|signin/.test(mw) && !/node:crypto|auth-config/.test(mw), "the proxy (formerly middleware) is a no-op when off, excludes /api, /_next, /signin and static files, and has no Node-only imports");
}

// ===== L1 — proxy (formerly middleware) behaviour, real module =====
{
  const group = "L1 Middleware";
  const { proxy: middleware } = await import("../../src/proxy");
  const { NextRequest } = await import("next/server");
  const saved = { AUTH_ENABLED: process.env.AUTH_ENABLED, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  try {
    delete process.env.AUTH_ENABLED;
    const off = await middleware(new NextRequest("http://localhost/my-work"));
    ok(group, off.headers.get("x-middleware-next") === "1", "sign-in off → every page passes through (no sign-in screen)");
    process.env.AUTH_ENABLED = "true";
    process.env.NEXTAUTH_SECRET = ENV_ON.NEXTAUTH_SECRET;
    const on = await middleware(new NextRequest("http://localhost/my-work?x=1"));
    const loc = on.headers.get("location") ?? "";
    ok(group, on.status === 307 && /\/signin\?callbackUrl=%2Fmy-work%3Fx%3D1$/.test(loc), `sign-in on, no session → redirect to /signin (${loc})`);
  } finally {
    if (saved.AUTH_ENABLED === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = saved.AUTH_ENABLED;
    if (saved.NEXTAUTH_SECRET === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = saved.NEXTAUTH_SECRET;
  }
}

// ===== L2 — one request-auth decision =====
{
  const group = "L2 Principal";
  const env = ENV_ON;
  const member = userRec("dev@acme.com");
  // Sign-in off: exactly today's checks, for every header.
  const headers = [null, "Bearer cron-s3cret", "Bearer app-s3cret", "Bearer write-s3cret", "Bearer nope"];
  const offSync = headers.every((h) => {
    const p = resolvePrincipal({ authEnabled: false, sessionUser: null, authorization: h, env });
    const legacy = checkSyncRequestAuth(h, env.CRON_SECRET, env.APP_STATE_SECRET);
    return legacy.ok ? p.kind === "legacy" : p.kind === "error" && p.status === legacy.status && p.error === legacy.error;
  });
  const offState = headers.every((h) => {
    const p = resolvePrincipal({ authEnabled: false, sessionUser: null, authorization: h, env, legacyCheck: "app-state" });
    const legacy = checkAppStateAuth(h, env.APP_STATE_SECRET);
    return legacy.ok ? p.kind === "legacy" : p.kind === "error" && p.status === legacy.status;
  });
  ok(group, offSync && offState, "sign-in off: identical results to checkSyncRequestAuth / checkAppStateAuth for every header");
  ok(group, resolvePrincipal({ authEnabled: false, sessionUser: member, authorization: null, env }).kind === "error", "sign-in off: a session alone never grants access (today's pairing rules apply)");

  const mis = resolvePrincipal({ authEnabled: true, missing: ["NEXTAUTH_SECRET"], sessionUser: member, authorization: null, env });
  ok(group, mis.kind === "error" && mis.status === 503 && /NEXTAUTH_SECRET/.test(mis.error) && mis.missing?.[0] === "NEXTAUTH_SECRET", "enabled + misconfigured → 503 naming the missing variable, even for a signed-in user");
  ok(group, misconfigurationError({ missing: ["A", "B"] }).endsWith("missing: A, B."), "the 503 text lists every missing variable");
  const anon = resolvePrincipal({ authEnabled: true, sessionUser: null, authorization: null, env });
  ok(group, anon.kind === "error" && anon.status === 401, "not signed in → 401");
  for (const secret of ["app-s3cret", "write-s3cret"]) {
    const p = resolvePrincipal({ authEnabled: true, sessionUser: member, authorization: `Bearer ${secret}`, env });
    ok(group, p.kind === "error" && p.status === 401, `sign-in on: a ${secret.startsWith("app") ? "APP_STATE_SECRET" : "JIRA_WRITE_SECRET"} bearer → 401, even alongside a session`);
  }
  ok(group, resolvePrincipal({ authEnabled: true, sessionUser: null, authorization: "Bearer cron-s3cret", env, allowCron: true }).kind === "cron", "CRON_SECRET → cron where allowed (the cron GET of /jira/sync)");
  const cronElsewhere = resolvePrincipal({ authEnabled: true, sessionUser: null, authorization: "Bearer cron-s3cret", env });
  ok(group, cronElsewhere.kind === "error" && cronElsewhere.status === 401, "…and 401 on every other route");
  const disabled = resolvePrincipal({ authEnabled: true, sessionUser: { ...member, disabled: true }, authorization: null, env });
  ok(group, disabled.kind === "error" && disabled.status === 403, "a disabled member is refused on every request (403)");
  const p = resolvePrincipal({ authEnabled: true, sessionUser: member, authorization: null, env });
  ok(group, p.kind === "user" && p.user.uid === member.uid, "a signed-in, enabled member → user");

  ok(group, isSameOrigin("https://cc.acme.com", "cc.acme.com") && !isSameOrigin("https://evil.com", "cc.acme.com") && !isSameOrigin(null, "cc.acme.com") && isSameOrigin("https://cc.acme.com", "internal:3000", "https://cc.acme.com"), "L7 CSRF: mutating /me and /admin calls need Origin = this app's host");

  // Every API route goes through the helper.
  const routes = ["jira/sync", "jira/issue-context", "jira/projects", "jira/conformance", "jira/status", "jira/write", "notify", "state", "reports/server", "reports/schedule", "ai", "ai/usage"];
  const missingHelper = routes.filter((r) => !/requestPrincipal\(req/.test(read(`src/app/api/command-center/${r}/route.ts`)));
  ok(group, missingHelper.length === 0, `every API route resolves the caller with requestPrincipal (${missingHelper.join(", ") || "all " + routes.length})`);
  const accountRoutes = ["me", "me/jira", "me/slack-test", "admin/users", "admin/invites"];
  ok(group, accountRoutes.every((r) => /accountRoute\(req, \{ mutating: (true|false) \}\)/.test(read(`src/app/api/command-center/${r}/route.ts`))), "the /me and /admin routes use the account helper (signed-in + CSRF on mutations)");
  const authSrc = read("src/lib/server/auth.ts");
  ok(group, /if \(opts\.mutating && !isSameOrigin\(/.test(authSrc) && /getServerSession\(authOptions\(\)\)/.test(authSrc), "the server wrapper checks Origin on mutations and reads the NextAuth session");
  const nextAuthRoute = read("src/app/api/auth/[...nextauth]/route.ts");
  ok(group, /settings\.missing\.length > 0\) return NextResponse\.json\(\{ ok: false, error: misconfigurationError\(settings\), missing: settings\.missing \}, \{ status: 503 \}\)/.test(nextAuthRoute), "the NextAuth route itself fails closed (503 + missing)");
}

// ===== L1/L3 — the user directory and the sign-in gate =====
const kv = createInMemoryKv();
const dir = createUserDirectory(kv);
{
  const group = "L1 Sign-in gate";
  const outsider = await dir.signIn("x@evil.com", "X", settingsOn, NOW);
  ok(group, !outsider.ok && outsider.reason === "not-allowed", "an email that isn't allowed is refused");
  const admin = await dir.signIn(ADMIN, "Lead", settingsOn, NOW);
  ok(group, admin.ok && admin.user.role === "admin" && admin.user.canWriteJira, "an AUTH_ADMIN_EMAILS member signs in as admin");
  const dev = await dir.signIn("dev@acme.com", "Dev", settingsOn, NOW);
  ok(group, dev.ok && dev.user.role === "member" && !dev.user.canWriteJira && dev.user.uid === userIdForEmail("dev@acme.com"), "a domain member signs in as member (no Jira writes by default)");
  await dir.adminUpdate(userIdForEmail("dev@acme.com"), { disabled: true }, settingsOn);
  const again = await dir.signIn("dev@acme.com", "Dev", settingsOn, NOW);
  ok(group, !again.ok && again.reason === "disabled", "a disabled user is refused at sign-in");
  await dir.adminUpdate(userIdForEmail("dev@acme.com"), { disabled: false }, settingsOn);
  const nextauth = read("src/lib/server/auth.ts");
  ok(group, /decision\.ok \? true : `\/signin\?error=\$\{decision\.reason === "disabled" \? "Disabled" : "AccessDenied"\}`/.test(nextauth), "NextAuth's signIn callback uses this gate and lands refusals on /signin with a reason");
  const page = read("src/app/signin/page.tsx");
  ok(group, /AccessDenied: "This email isn't allowed to sign in/.test(page) && /Disabled: "This account has been disabled/.test(page) && /settings\.missing\.map/.test(page), "the sign-in page explains 'not allowed', 'disabled' and a misconfiguration");
}

// ===== L3 — encrypted secrets =====
{
  const group = "L3 Secret box";
  const uid = userIdForEmail("dev@acme.com");
  const sealed = encryptSecret("atl-token-123", KEY, uid);
  ok(group, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(sealed) && !sealed.includes("atl-token-123"), "format v1:iv:tag:ct, no plaintext");
  ok(group, decryptSecret(sealed, KEY, uid) === "atl-token-123", "round trip with the right key");
  const otherKey = resolveEncryptionKey({ NEXTAUTH_SECRET: "a different secret" })!;
  ok(group, decryptSecret(sealed, otherKey, uid) === null, "the wrong key fails (null, never garbage)");
  const parts = sealed.split(":");
  const flipped = parts[3][0] === "A" ? "B" : "A";
  ok(group, decryptSecret([parts[0], parts[1], parts[2], flipped + parts[3].slice(1)].join(":"), KEY, uid) === null, "tampered ciphertext fails");
  ok(group, decryptSecret(sealed, KEY, userIdForEmail("other@acme.com")) === null, "a ciphertext copied into another user's record fails (uid is bound in)");
  const hexKey = resolveEncryptionKey({ AUTH_ENCRYPTION_KEY: "11".repeat(32), NEXTAUTH_SECRET: "x" })!;
  ok(group, hexKey.length === 32 && hexKey[0] === 0x11 && resolveEncryptionKey({ AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") })![0] === 7, "AUTH_ENCRYPTION_KEY (hex or base64, 32 bytes) wins over the NEXTAUTH_SECRET HKDF");
}

// ===== L3 — connecting Jira, /me never leaks =====
const ctxFor = (email: string, over: Partial<AccountContext> = {}): AccountContext => ({ user: userRec(email, email === ADMIN ? { role: "admin", canWriteJira: true } : {}), directory: dir, env: ENV_ON, settings: settingsOn, key: KEY, now: () => NOW, ...over });
{
  const group = "L3 Jira connection";
  const calls: { url: string; auth?: string }[] = [];
  const jiraFake: FetchLike = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const ok = init?.headers?.Authorization === "Basic " + Buffer.from("dev@acme.com:good-token").toString("base64");
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { accountId: "acc-dev-from-jira", displayName: "Dev From Jira" } : {}) };
  };
  const ctx = ctxFor("dev@acme.com");
  const bad = await handleJiraConnect(ctx, { email: "dev@acme.com", apiToken: "wrong" }, jiraFake);
  ok(group, bad.status === 400 && (await dir.getProfile(ctx.user.uid)).jira.mode === "none", "a token Jira rejects is not stored");
  const good = await handleJiraConnect(ctx, { email: "dev@acme.com", apiToken: "good-token" }, jiraFake);
  ok(group, good.status === 200 && calls.every((c) => c.url === "https://acme.atlassian.net/rest/api/3/myself"), "verified via GET {JIRA_BASE_URL}/rest/api/3/myself — always the server's host");
  const stored = await dir.getProfile(ctx.user.uid);
  ok(group, stored.jira.mode === "personal" && stored.jira.accountId === "acc-dev-from-jira" && stored.jira.displayName === "Dev From Jira", "accountId and display name come from /myself");
  ok(group, !!stored.jira.tokenEnc && !JSON.stringify(stored).includes("good-token") && decryptSecret(stored.jira.tokenEnc, KEY, ctx.user.uid) === "good-token", "the token is stored encrypted only");
  ok(group, (await handleJiraConnect(ctx, { email: "dev@acme.com", apiToken: "good-token", baseUrl: "https://evil.example" }, jiraFake)).status === 400, "a user-supplied host is refused (strict body)");
  const cfg = jiraConfigForUser(ctx.user.uid, stored, ENV_ON, KEY, false);
  ok(group, cfg.ok && cfg.mode === "personal" && cfg.config.baseUrl === ENV_ON.JIRA_BASE_URL && cfg.config.apiToken === "good-token" && cfg.accountId === "acc-dev-from-jira", "requests then run with the member's own connection");
  ok(group, !jiraConfigForUser(ctx.user.uid, stored, ENV_ON, resolveEncryptionKey({ NEXTAUTH_SECRET: "rotated" }), false).ok, "a rotated key makes the stored token unusable (reconnect), never a wrong token");

  await handleMePatch(ctx, { slack: { mode: "personal", webhookUrl: "https://hooks.slack.com/services/T000/B000/secretwebhook123" }, notifyEnabled: true });
  const me = await handleMeGet(ctx);
  const body = JSON.stringify(me.body);
  ok(group, me.status === 200 && !body.includes("good-token") && !body.includes("secretwebhook123") && !body.includes("tokenEnc") && !body.includes("webhookEnc") && !/v1:[A-Za-z0-9_-]{8,}:/.test(body), "GET /me never contains the token, the webhook or any ciphertext");
  ok(group, (me.body.profile as { jira: { connected: boolean }; slack: { configured: boolean } }).jira.connected && (me.body.profile as { slack: { configured: boolean } }).slack.configured, "…only that they are set");
  ok(group, slackWebhookForUser(ctx.user.uid, await dir.getProfile(ctx.user.uid), ENV_ON, KEY) === "https://hooks.slack.com/services/T000/B000/secretwebhook123", "the server can still use the webhook it stored");
  ok(group, (await handleMePatch(ctx, { slack: { mode: "personal", webhookUrl: "https://evil.example/hook" } })).status === 400, "only Slack incoming-webhook URLs are accepted");

  // Shared mode: off by default, read-only when on.
  ok(group, !settingsOn.allowSharedJira && (await handleMePatch(ctxFor("dev2@acme.com"), { jira: { mode: "shared", accountId: "acc-x" } })).status === 403, "shared Jira is off by default (AUTH_ALLOW_SHARED_JIRA)");
  const sharedEnv = { ...ENV_ON, AUTH_ALLOW_SHARED_JIRA: "true", JIRA_EMAIL: "svc@acme.com", JIRA_API_TOKEN: "svc-token" };
  const sharedCtx = ctxFor("dev2@acme.com", { env: sharedEnv, settings: readAuthSettings(sharedEnv) });
  const shared = await handleMePatch(sharedCtx, { jira: { mode: "shared", accountId: "acc-dev2" } });
  const sharedCfg = jiraConfigForUser(sharedCtx.user.uid, await dir.getProfile(sharedCtx.user.uid), sharedEnv, KEY, true);
  ok(group, shared.status === 200 && sharedCfg.ok && sharedCfg.mode === "shared" && sharedCfg.accountId === "acc-dev2" && !JSON.stringify(shared.body).includes("svc-token"), "when allowed, shared mode uses the server's token with the member's accountId (never shown)");

  // accountId authority in the sync.
  ok(group, effectiveAccountId("acc-dev-from-jira", "acc-someone-else") === "acc-dev-from-jira" && effectiveAccountId(undefined, "acc-req") === "acc-req", "the profile accountId is authoritative; the request's is used only without one");
  const sync = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /const requestAccountId = effectiveAccountId\(memberJira\?\.ok \? memberJira\.accountId : undefined, parsedRequest\.data\.accountId\);/.test(sync) && /const accountId = requestAccountId;/.test(sync), "the sync route uses it for both mentions and my-activity");

  await handleJiraDisconnect(ctx);
  ok(group, (await dir.getProfile(ctx.user.uid)).jira.mode === "none" && !(await dir.getProfile(ctx.user.uid)).jira.tokenEnc, "DELETE disconnects (the ciphertext is dropped)");
  await handleJiraConnect(ctx, { email: "dev@acme.com", apiToken: "good-token" }, jiraFake);
}

// ===== L6 — admin =====
{
  const group = "L6 Team admin";
  const member = ctxFor("dev@acme.com");
  ok(group, (await handleAdminUsersGet(member)).status === 403 && (await handleAdminUsersPatch(member, { uid: member.user.uid, role: "admin" })).status === 403 && (await handleInvite(member, { email: "a@b.co" }, "add")).status === 403, "admin routes answer 403 to members");
  const admin = ctxFor(ADMIN);
  const list = await handleAdminUsersGet(admin);
  const rows = list.body.users as { email: string; jiraConnected: boolean }[];
  ok(group, list.status === 200 && rows.some((u) => u.email === "dev@acme.com" && u.jiraConnected) && !JSON.stringify(list.body).includes("good-token"), "admins see members (Jira connected?) — never their secrets");
  const inv = await handleInvite(admin, { email: "Guest@Partner.io" }, "add");
  ok(group, (inv.body.invites as string[]).includes("guest@partner.io") && (await dir.signIn("guest@partner.io", "G", settingsOn, NOW)).ok, "an invite lets that email sign in");
  await handleInvite(admin, { email: "guest@partner.io" }, "remove");
  ok(group, !(await dir.signIn("guest2@partner.io", "G", settingsOn, NOW)).ok, "without an invite a non-domain email is refused");
  const demoteEnvAdmin = await handleAdminUsersPatch(admin, { uid: userIdForEmail(ADMIN), role: "member" });
  ok(group, demoteEnvAdmin.status === 400 && /AUTH_ADMIN_EMAILS/.test(String(demoteEnvAdmin.body.error)), "an AUTH_ADMIN_EMAILS admin can't be demoted or disabled in the UI");
  // A second, UI-made admin can't remove the last remaining one.
  const solo = createUserDirectory(createInMemoryKv());
  await solo.signIn("pm@acme.com", "PM", settingsOn, NOW);
  await solo.adminUpdate(userIdForEmail("pm@acme.com"), { role: "admin" }, { adminEmails: [] });
  const last = await solo.adminUpdate(userIdForEmail("pm@acme.com"), { role: "member" }, { adminEmails: [] });
  ok(group, !last.ok && /last admin/.test(last.error), "an admin cannot remove the last admin");
  const write = await handleAdminUsersPatch(admin, { uid: userIdForEmail("dev@acme.com"), canWriteJira: true });
  ok(group, write.status === 200 && (await dir.getUser(userIdForEmail("dev@acme.com")))!.canWriteJira, "admins grant Jira-write permission per member");
  await dir.adminUpdate(userIdForEmail("dev@acme.com"), { canWriteJira: false }, settingsOn);
}

// ===== L4 — per-user server data on ONE KV =====
{
  const group = "L4 Data isolation";
  const shared = createInMemoryKv();
  const A = userIdForEmail("a@acme.com");
  const B = userIdForEmail("b@acme.com");
  const stateFor = (who: string) => ({ jiraWorkRelevancePolicy: {}, attentionState: {}, decisions: [{ id: who }], actionPlanState: { actions: [], personalPlan: [] }, memoryEvents: [], uiPreferences: {}, updatedAtIso: NOW.toISOString() }) as never;
  await createKvAppStateStore(shared, A).set(stateFor("A-decision"));
  await createKvAppStateStore(shared, B).set(stateFor("B-decision"));
  const aState = JSON.stringify(await createKvAppStateStore(shared, A).get());
  ok(group, aState.includes("A-decision") && !aState.includes("B-decision") && JSON.stringify(await createKvAppStateStore(shared, B).get()).includes("B-decision"), "app-state: A reads only A's; B's write never overwrote A's");
  ok(group, (await createKvAppStateStore(shared).get()) === null && (await shared.get(APP_STATE_KEY)) === null, "neither touches the single-user key");

  await createKvServerReportStore(shared, A).set({ baseline: null, reports: { "2026-10-07": { a: 1 } } } as never);
  ok(group, (await createKvServerReportStore(shared, B).get()) === null, "server reports: B can't read A's");
  await createKvNotifyStore(shared, A).set({ assignedIssueKeys: ["A-1"], notifiedCommentIds: [], lastCheckedAtIso: NOW.toISOString() });
  ok(group, (await createKvNotifyStore(shared, B).get()) === null && (await createKvNotifyStore(shared, A).get())!.assignedIssueKeys[0] === "A-1", "notify state: per member");
  await createKvJiraWriteLogStore(shared, A).append({ at: NOW.toISOString(), issueKey: "PAY-1", action: "comment", outcome: "ok", uid: A });
  ok(group, (await createKvJiraWriteLogStore(shared, B).list(10)).length === 0 && (await createKvJiraWriteLogStore(shared, A).list(10))[0].uid === A, "write log: B never sees A's entries");

  const ledger = new MemoryUsageLedger();
  const rec = (uid: string, t: number) => ({ id: uid + t, at: NOW.toISOString(), day: "2026-10-07", task: "explainChanges" as const, model: "m", tier: "fast" as const, inputTokens: t, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false, outcome: "ok" as const, uid });
  await ledger.append(rec(A, 500));
  await ledger.append(rec(B, 70));
  const all = await ledger.listDays(["2026-10-07"]);
  ok(group, summarizeUsage(recordsOfUser(all, B), 1000, NOW, "memory").today.totalTokens === 70 && summarizeUsage(all, 1000, NOW, "memory").today.totalTokens === 570, "AI usage: 'you' counts only your calls; 'team' (admins) counts all");
  const usageRoute = read("src/app/api/command-center/ai/usage/route.ts");
  ok(group, /recordsOfUser\(records, p\.user\.uid\)/.test(usageRoute) && /p\.user\.role === "admin" \? \{ team \} : \{\}/.test(usageRoute), "the usage route serves 'you' to everyone and 'team' to admins only");
  const stateRoute = read("src/app/api/command-center/state/route.ts");
  ok(group, /createAppStateStore\(scopeOf\(p\)\)\.get\(\)/.test(stateRoute) && /createAppStateStore\(scopeOf\(p\)\)\.set\(/.test(stateRoute) && /createServerReportStore\(scopeOf\(p\)\)/.test(read("src/app/api/command-center/reports/server/route.ts")), "the state and server-report routes read/write the caller's own scope");
}

// ===== L4 — Jira write per member =====
{
  const group = "L4 Jira write";
  const env = { JIRA_WRITE_ENABLED: "true", JIRA_WRITE_PROJECT_KEYS: "PAY" };
  ok(group, readJiraWriteConfig(env, { requireSecret: false }).missing.length === 0 && readJiraWriteConfig(env).missing.includes("JIRA_WRITE_SECRET"), "with sign-in, JIRA_WRITE_SECRET isn't required");
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 204, json: async () => ({}) });
  const provider = new HttpJiraActionProvider(fetchImpl, { baseUrl: "https://acme.atlassian.net", email: "a@acme.com", apiToken: "t" });
  const limiters = createPerUserRateLimiters(2);
  const logs = new Map<string, ReturnType<typeof createInMemoryJiraWriteLog>>();
  const logFor = (uid: string) => logs.get(uid) ?? (logs.set(uid, createInMemoryJiraWriteLog()), logs.get(uid)!);
  const comment: JiraWriteGateRequest = { action: "comment", issueKey: "PAY-12", text: "Hi" };
  const write = (email: string, canWriteJira: boolean, jiraMode: "personal" | "shared" | "none") => {
    const uid = userIdForEmail(email);
    return handleJiraWriteRequest(comment, null, { env, provider, limiter: limiters(uid), log: logFor(uid), now: () => NOW, member: { uid, email, canWriteJira, jiraMode } });
  };
  ok(group, (await write("m@acme.com", false, "personal")).status === 403, "a member without canWriteJira → 403");
  ok(group, (await write("s@acme.com", true, "shared")).status === 403, "shared Jira → writes 403");
  ok(group, (await write("n@acme.com", true, "none")).status === 403, "no Jira connection → 403");
  const a = [await write("a@acme.com", true, "personal"), await write("a@acme.com", true, "personal"), await write("a@acme.com", true, "personal")].map((r) => r.status);
  const b = await write("b@acme.com", true, "personal");
  ok(group, a.join() === "200,200,429" && b.status === 200, `the rate limit is per member (A: ${a.join()}, B: ${b.status})`);
  const entry = logFor(userIdForEmail("a@acme.com")).entries[0];
  ok(group, entry.uid === userIdForEmail("a@acme.com") && entry.email === "a@acme.com" && logFor(userIdForEmail("b@acme.com")).entries.every((e) => e.uid === userIdForEmail("b@acme.com")), "log entries record uid/email, in that member's own log");
  ok(group, (await handleJiraWriteRequest(comment, "Bearer nope", { env: { ...env, JIRA_WRITE_SECRET: "s" }, provider, limiter: limiters("x"), log: createInMemoryJiraWriteLog(), now: () => NOW })).status === 401, "sign-in off: the JIRA_WRITE_SECRET pairing still decides, unchanged");
  const route = read("src/app/api/command-center/jira/write/route.ts");
  ok(group, /limiter: memberLimiter\(user\.uid\)/.test(route) && /log: createJiraWriteLogStore\(user\.uid\)/.test(route) && /member: \{ uid: user\.uid, email: user\.email, canWriteJira: user\.canWriteJira, jiraMode \}/.test(route), "the route gives each member their own limiter and log");
}

// ===== L4 — the cron, per member =====
{
  const group = "L4 Cron per member";
  const ckv = createInMemoryKv();
  const cdir = createUserDirectory(ckv);
  const members = ["one@acme.com", "two@acme.com", "three@acme.com"];
  for (const email of members) {
    await cdir.signIn(email, email, settingsOn, NOW);
    const uid = userIdForEmail(email);
    await cdir.setProfile(uid, { jira: { mode: "personal", email, tokenEnc: encryptSecret(`token-${email}`, KEY, uid), accountId: `acc-${email}` }, slack: { mode: "none" }, notifyEnabled: true, dailySnapshotEnabled: true, timezoneOffsetMinutes: 0 });
  }
  await cdir.signIn("idle@acme.com", "Idle", settingsOn, NOW); // nothing switched on → not processed
  const { plans, skipped } = await planCronMembers(cdir, ENV_ON, KEY, false);
  ok(group, plans.length === 3 && skipped.length === 0 && plans.every((p) => p.config.apiToken === `token-${p.email}` && p.accountId === `acc-${p.email}`), "plans one run per member who turned notify/snapshot on, each with their own token and accountId");
  const seenTokens = new Set<string>();
  const fetchImpl: FetchLike = async (url, init) => {
    const auth = init?.headers?.Authorization ?? "";
    seenTokens.add(auth);
    if (auth === "Basic " + Buffer.from("two@acme.com:token-two@acme.com").toString("base64")) return { ok: false, status: 401, json: async () => ({ errorMessages: ["revoked"] }) };
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    return { ok: true, status: 200, json: async () => ({ comments: [] }) };
  };
  const stores = new Map<string, { notifyStore: ReturnType<typeof createInMemoryNotifyStore>; reportStore: ReturnType<typeof createInMemoryServerReportStore> }>();
  const result = await runCronForMembers(fetchImpl, plans, {
    storesFor: (uid) => stores.get(uid) ?? (stores.set(uid, { notifyStore: createInMemoryNotifyStore(), reportStore: createInMemoryServerReportStore() }), stores.get(uid)!),
    now: () => NOW,
    snapshotHourLocal: 0,
    budgetMs: 60_000,
  });
  ok(group, result.usersProcessed === 3 && result.failures.length === 1 && result.failures[0].email === "two@acme.com", `3 members processed; the one whose Jira answers 401 is reported (${result.failures.map((f) => f.email).join()})`);
  const okUids = ["one@acme.com", "three@acme.com"].map(userIdForEmail);
  ok(group, await Promise.all(okUids.map(async (u) => (await stores.get(u)!.notifyStore.get()) !== null && (await stores.get(u)!.reportStore.get()) !== null)).then((r) => r.every(Boolean)), "…and the other two still got their notify baseline and snapshot");
  ok(group, seenTokens.size === 3, "each member's runs used that member's own credentials");
  let t = 0;
  const budgeted = await runCronForMembers(fetchImpl, plans, { storesFor: () => ({}), now: () => NOW, budgetMs: 5, clock: () => (t += 10) });
  ok(group, budgeted.skipped.length > 0 && budgeted.usersProcessed + budgeted.skipped.length === 3, "a per-run time budget: members not reached are reported as skipped");
  const route = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /if \(isAuthEnabled\(process\.env\)\) return memberCron\(req\);/.test(route) && /requestPrincipal\(req, \{ allowCron: true \}\)/.test(route) && /createNotifyStore\(uid\)/.test(route) && /createServerReportStore\(uid\)/.test(route), "the cron GET (sign-in on) runs per member with that member's stores; CRON_SECRET only there");
  const notifySrc = read("src/lib/command-center/cron-notify.ts");
  ok(group, /"webhookUrl" in options \? options\.webhookUrl : process\.env\.SLACK_WEBHOOK_URL/.test(notifySrc), "runServerSideNotifyCheck takes the webhook as a parameter (env only when none is passed)");
}

// ===== L4 — per-user AI cap =====
{
  const group = "L4 AI cap per member";
  const calls: ModelCallParams[] = [];
  const callModel = async (p: ModelCallParams): Promise<ModelCallResult> => {
    calls.push(p);
    return { stopReason: "end_turn", text: JSON.stringify({ text: "PAY-1 moved to Blocked." }), usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  };
  const ledger = new MemoryUsageLedger();
  const cache = new ResponseCache();
  const input = { task: "explainChanges", input: { change: { entityLabel: "PAY-1 Export", entityType: "WorkItem", field: "status", before: "To Do", after: "Blocked", impact: "Release 2.4 at risk" } } };
  const as = (uid: string, _n: number) => handleAiRequest(input, { env: { AI_DAILY_TOKEN_CAP: "100000" }, callModel, ledger, now: () => NOW, cache, user: { uid, cap: 100 } });
  const A = userIdForEmail("a@acme.com");
  const B = userIdForEmail("b@acme.com");
  const first = await as(A, 1);
  const second = await as(A, 2);
  const other = await as(B, 3);
  ok(group, first.status === 200 && second.status === 429 && second.body.errorKind === "user-budget-exhausted" && other.status === 200, `the per-member cap → 429 for that member only (A: ${first.status},${second.status}; B: ${other.status})`);
  ok(group, calls.length === 2 && (await ledger.listDays(["2026-10-07"])).every((r) => r.uid === A || r.uid === B), "no model call for the refused request; every record carries its uid");
  ok(group, resolveUserDailyTokenCap(undefined) === null && resolveUserDailyTokenCap("50000") === 50000, "AI_USER_DAILY_TOKEN_CAP unset → no per-member cap");
}

// ===== L5 — per-user browser data on ONE device =====
{
  const group = "L5 Browser isolation";
  const A = userIdForEmail("a@acme.com");
  const B = userIdForEmail("b@acme.com");
  const legacy = JSON.stringify({ loaded: true, ownerName: "Legacy Owner", personalIdentity: { id: "legacy", displayName: "Legacy Owner" } });
  const device = createMemoryKeyedBackend({ "command-center:v1": legacy });
  const open = (uid: string, adoptLegacy = false) => {
    const s = new CommandCenterStore({ stateBackend: device, stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
    ok(group, s.setUserNamespace(uid, { adoptLegacy }), `namespace set before the first read (${uid.slice(0, 8)}…)`);
    s.getSnapshot();
    return s;
  };
  const b1 = open(B);
  await tick();
  ok(group, b1.getSnapshot().personalIdentity === undefined && device.dump()["command-center:v1"] === legacy, "user B (not the legacy owner) starts pristine and never reads or touches the legacy data");
  const a = open(A, true);
  await tick();
  ok(group, a.getSnapshot().personalIdentity?.displayName === "Legacy Owner" && !("command-center:v1" in device.dump()) && !!device.dump()[userStorageKey(A)], "the AUTH_LEGACY_DATA_OWNER adopts it into their own key; the legacy key is then deleted");
  a.setPersonalIdentity({ displayName: "Alice A", accountId: "acc-a" });
  await tick();
  const b2 = open(B);
  await tick();
  ok(group, b2.getSnapshot().personalIdentity?.displayName !== "Alice A" && !(device.dump()[userStorageKey(B)] ?? "").includes("Alice A"), "user B on the same device never sees user A's data");
  const a2 = open(A, true);
  await tick();
  ok(group, a2.getSnapshot().personalIdentity?.displayName === "Alice A", "A's own data is still A's on the next load");
  const fresh = createMemoryKeyedBackend({ "command-center:v1": legacy, [userStorageKey(A)]: device.dump()[userStorageKey(A)] });
  const s = new CommandCenterStore({ stateBackend: fresh, stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  s.setUserNamespace(A, { adoptLegacy: true });
  s.getSnapshot();
  await tick();
  ok(group, s.getSnapshot().personalIdentity?.displayName === "Alice A" && fresh.dump()["command-center:v1"] === legacy, "the owner's key already has data → legacy data is never copied over it (adopted once)");
  const late = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  late.getSnapshot();
  ok(group, !late.setUserNamespace(A), "too late after the first read — AuthGate then reloads instead of mixing data sets");
  const gate = read("src/components/command-center/AuthGate.tsx");
  ok(group, /setSessionAuthMode\(true\);\s*if \(!commandCenterStore\.setUserNamespace\(r\.me\.user\.uid, \{ adoptLegacy: r\.me\.adoptLegacyData \}\)\)/.test(gate) && /phase\.kind === "loading"\) return/.test(gate), "AuthGate configures the namespace before rendering anything");
  const storeSrc = read("src/lib/command-center/store.ts");
  ok(group, /namedBrowserStateChannel\(`\$\{STATE_CHANNEL_NAME\}:\$\{this\.namespace\.uid\}`\)/.test(storeSrc) && /export const userStorageKey = \(uid: string\) => `\$\{STORAGE_KEY\}:u:\$\{uid\}`;/.test(storeSrc), "IndexedDB key command-center:v1:u:<uid>; BroadcastChannel suffixed with the uid");

  ok(group, isDevicePaired() === false && pairedAuthHeader() === undefined, "sign-in off (Node, no pairing): unpaired, as before");
  setSessionAuthMode(true);
  ok(group, isDevicePaired() && pairedAuthHeader() === undefined && jiraWriteAuthHeader() === undefined, "session mode: counts as paired; no pairing header is sent (the cookie authenticates)");
  setSessionAuthMode(false);

  const me: Me = { user: { uid: A, email: "a@acme.com", name: "Alice", role: "member", canWriteJira: false }, profile: { jira: { mode: "personal", connected: true, accountId: "acc-a", displayName: "Alice Jira" }, slack: { mode: "none", configured: false }, notifyEnabled: false, dailySnapshotEnabled: false }, options: { allowSharedJira: false, teamSlackConfigured: false }, adoptLegacyData: false };
  ok(group, identityFromMe(undefined, me)?.accountId === "acc-a" && identityFromMe({ id: "i", displayName: "Alice Jira", accountId: "acc-a" }, me) === null, "AuthGate pushes the profile accountId/name into personalIdentity only when they differ");
}

// ===== L5 — cross-device sync actually runs when signed in =====
// Regression: getServerState/pushServerState used to bail out as "not-paired" whenever
// pairedAuthHeader() was empty — which it always is in session mode — so a signed-in member's
// settings (Work Relevance Policy, preferences, decisions…) never left the device.
{
  const group = "L5 session sync";
  const uid = "u_0123456789abcdef01234567";
  let serverBlob: unknown = null;
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (String(url).endsWith("/api/command-center/state")) {
      calls.push(`${method} auth=${new Headers(init?.headers).has("authorization")}`);
      if (method === "POST") serverBlob = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ ok: true, state: method === "GET" ? serverBlob : undefined }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  setSessionAuthMode(true);
  try {
    const deviceA = new CommandCenterStore({ stateBackend: createMemoryKeyedBackend(), stateChannel: null, stateFocusTargets: [] });
    deviceA.setUserNamespace(uid);
    deviceA.getSnapshot();
    await tick();
    deviceA.setJiraStatusRelevance("In QA", "NOT_MY_WORK");
    resetAppStateSyncForNewPairing();
    await initAppStateSync(deviceA);
    ok(group, calls.length > 0 && calls.every((c) => c.endsWith("auth=false")), "session mode: the state endpoint is called, with no pairing header (cookie auth)");
    ok(group, (serverBlob as { jiraWorkRelevancePolicy?: Record<string, string> } | null)?.jiraWorkRelevancePolicy?.["In QA"] === "NOT_MY_WORK", "device A pushes its Work Relevance Policy to the member's server blob");

    const deviceB = new CommandCenterStore({ stateBackend: createMemoryKeyedBackend(), stateChannel: null, stateFocusTargets: [] });
    deviceB.setUserNamespace(uid);
    deviceB.getSnapshot();
    await tick();
    resetAppStateSyncForNewPairing();
    await initAppStateSync(deviceB);
    ok(group, deviceB.getSnapshot().jiraWorkRelevancePolicy["In QA"] === "NOT_MY_WORK", "a fresh device B signed in as the same member receives the policy");
  } finally {
    resetAppStateSyncForNewPairing();
    setSessionAuthMode(false);
    globalThis.fetch = realFetch;
  }
}

// ===== L6/L7 — UI wiring and docs =====
{
  const group = "L6 UI";
  const settings = read("src/app/data-settings/page.tsx");
  ok(group, /<MyAccountPanel \/>/.test(settings) && /<TeamAdminPanel \/>/.test(settings) && /\{!authSession && <CrossDeviceSyncPanel \/>\}/.test(settings), "Data & Settings: My account and Team; device pairing hidden when signed in");
  ok(group, /\{!sessionMode && \(/.test(read("src/components/command-center/JiraWriteBackPanel.tsx")), "the JIRA_WRITE_SECRET pairing is hidden when signed in");
  ok(group, /if \(!isAdmin\) return null;/.test(read("src/components/command-center/TeamAdminPanel.tsx")), "Team renders for admins only");
  ok(group, /<UserMenu \/>/.test(read("src/components/command-center/Header.tsx")) && /signOut\(/.test(read("src/components/command-center/UserMenu.tsx")), "header user menu with Sign out");
  const idx = buildWorkRelevanceIndex({});
  const rows = computeSetupHealthRows(undefined, "demo", emptyData(), idx, null, { authMissing: ["NEXTAUTH_SECRET"] });
  ok(group, rows.some((r) => r.id === "auth-config" && /NEXTAUTH_SECRET/.test(r.text)), "Setup Health names the missing sign-in variable");
  const files = ["src/lib/server/auth.ts", "src/lib/command-center/auth/account-handlers.ts", "src/lib/command-center/auth/connections.ts", "src/lib/command-center/auth/secret-box.ts"];
  ok(group, files.every((f) => !/console\.(log|info|warn|error)\(/.test(read(f))), "no auth module logs anything (so no secret can be logged)");
  const readme = read("README.md");
  ok(group, /\| `AUTH_ENABLED`/.test(readme) && /\| `AUTH_ENCRYPTION_KEY`/.test(readme) && /Google/.test(readme) && /Entra/.test(readme) && /AUTH_LEGACY_DATA_OWNER/.test(readme) && /## Team sign-in \(V2\.40\)/.test(readme), "README: env table, Google/Entra setup, KV, migration");
}
