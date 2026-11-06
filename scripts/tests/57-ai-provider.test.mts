// D1 — AI provider setup: write-only sealed key, validation, error mapping, resolution order, auth scopes, rate limit, secrecy.
import fs from "node:fs";
import { ok } from "./harness.mts";
import {
  aiEncryptionKey, mapProviderError, modelEnvFor, effectiveCap, openRecord, redactSecrets, resolveCredentials, scopeId, scopesFor, sealRecord,
  validateApiKey, validateBaseUrl, validateCap, validateModels, type AiProviderRecord, type AuditEntry, type ProviderEnv, type ProviderStore,
} from "../../src/lib/command-center/ai/provider-config";
import { RateLimiter, deleteProvider, getProviderStatus, putProvider, testProvider, type ProviderCtx, type ProviderPrincipal, type ProviderSdk } from "../../src/lib/command-center/ai/provider-handlers";

const KEY = "sk-ant-api03-TESTKEYTESTKEY-abcdef0123456789";
const KEY2 = "sk-ant-api03-SECONDKEYSECOND-9876543210fedcba";
const NOW = new Date("2026-11-05T09:00:00.000Z");

function memStore(): ProviderStore & { recs: Map<string, AiProviderRecord>; audit: AuditEntry[] } {
  const recs = new Map<string, AiProviderRecord>();
  const audit: AuditEntry[] = [];
  return { recs, audit, get: async (id) => (recs.has(id) ? JSON.parse(JSON.stringify(recs.get(id))) : null), put: async (id, r) => void recs.set(id, JSON.parse(JSON.stringify(r))), del: async (id) => void recs.delete(id), appendAudit: async (e) => void audit.push(e), listAudit: async () => audit };
}
const okSdk = (models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]): ProviderSdk & { pings: string[] } => { const pings: string[] = []; return { pings, listModels: async () => models, ping: async (_k, m) => void pings.push(m) }; };
const ENV: ProviderEnv = { APP_STATE_SECRET: "paired-secret-for-tests-0123456789" };
const ctxOf = (over: Partial<ProviderCtx> = {}): ProviderCtx => ({ store: memStore(), env: ENV, sdk: okSdk(), now: () => NOW, principal: { kind: "legacy" }, limiter: new RateLimiter(), ...over });
const user = (uid: string, role: "admin" | "member" = "member"): ProviderPrincipal => ({ kind: "user", uid, role });
const everything: string[] = []; // every response / audit / error produced, for the secrecy sweep
const rec = (r: { status: number; body: Record<string, unknown> }) => { everything.push(JSON.stringify(r)); return r; };

{
  const group = "D1 validation";
  const bad = (k: unknown) => !validateApiKey(k).ok;
  ok(group, bad("") && bad("   ") && bad(undefined) && bad(12), "empty / whitespace / non-string key rejected");
  ok(group, bad("sk-ant-abc def") && bad("sk-ant-abc\ndef") && bad("sk-ant-abc\u0007def"), "spaces, newlines and control characters inside the key rejected");
  ok(group, bad("sk-ant-" + "x".repeat(300)) && bad("sk-wrong-prefix-123456"), "over 300 characters / wrong prefix rejected");
  const trimmed = validateApiKey(`  ${KEY}\n`);
  ok(group, trimmed.ok && trimmed.value === KEY, "a pasted key with outer whitespace is accepted trimmed");
  ok(group, !validateCap(-1, 1000).ok && !validateCap(1.5, 1000).ok && !validateCap(2000, 1000).ok && validateCap(500, 1000).ok && validateCap(0, 1000).ok, "daily cap: integer >= 0 and <= the hard cap");
  ok(group, !validateModels({ fast: "bad model!" }).ok && !validateModels({ turbo: "claude-x-1" }).ok && validateModels({ fast: "claude-haiku-5-5" }).ok, "model ids validated; unknown tiers rejected");
  const url = (u: string, allowed = true) => validateBaseUrl(u, allowed).ok;
  ok(group, !url("https://proxy.example.com", false), "a custom base URL is refused unless allowed");
  ok(group, url("https://proxy.example.com/v1") && !url("http://proxy.example.com") && !url("https://user:pw@proxy.example.com"), "https only, no credentials");
  ok(group, !url("https://localhost/x") && !url("https://127.0.0.1") && !url("https://10.0.0.5") && !url("https://192.168.1.1") && !url("https://169.254.169.254/latest") && !url("https://172.20.0.1") && !url("https://[::1]/") && !url("https://metadata.google.internal"), "localhost / private / link-local / metadata hosts rejected");
}

{
  const group = "D1 error mapping (table)";
  const t: [number | undefined, string][] = [[401, "invalid-key"], [403, "permission"], [404, "model-not-found"], [429, "rate-limited"], [500, "provider-down"], [529, "provider-down"]];
  for (const [status, kind] of t) ok(group, mapProviderError({ status }).kind === kind && mapProviderError({ status }).message.length > 10, `HTTP ${status} -> ${kind}`);
  ok(group, mapProviderError(new Error("Request timed out.")).kind === "timeout" && mapProviderError(new Error("fetch failed")).kind === "network" && mapProviderError(new Error("weird")).kind === "unknown", "timeouts / network / unknown");
  ok(group, !redactSecrets(`oops ${KEY} here`).includes("TESTKEY"), "redactSecrets removes a key from any string");
}

{
  const group = "D1 save, status, test (single-user)";
  const ctx = ctxOf();
  const put = rec(await putProvider(ctx, { apiKey: KEY }));
  ok(group, put.status === 200 && put.body.last4 === KEY.slice(-4), "saving a valid key works");
  const store = ctx.store as ReturnType<typeof memStore>;
  const stored = store.recs.get("global")!;
  ok(group, !JSON.stringify(stored).includes("TESTKEY") && stored.sealedKey.startsWith("v1:"), "the stored record holds only the sealed key");
  const st = rec(await getProviderStatus(ctx));
  ok(group, st.body.configured === true && st.body.source === "global" && st.body.last4 === KEY.slice(-4) && st.body.canStoreKey === true && !JSON.stringify(st).includes("TESTKEY"), "status: configured, source, last4 — never the key");
  const sdk = ctx.sdk as ReturnType<typeof okSdk>;
  const test = rec(await testProvider(ctx));
  const tiers = test.body.tiers as Record<string, { ok: boolean }>;
  ok(group, test.status === 200 && test.body.ok === true && tiers.fast.ok && tiers.default.ok && tiers.deep.ok && sdk.pings.length === 3, "test: models.list then one tiny call per tier");
  ok(group, store.recs.get("global")!.verifiedAt === NOW.toISOString(), "a passing test marks the record verified");
  // unknown model id: flagged, NOT verified; saving it is still allowed
  const put2 = rec(await putProvider(ctx, { models: { default: "claude-nonexistent-9" } }));
  ok(group, put2.status === 200, "saving an unknown (custom) model id is allowed");
  const test2 = rec(await testProvider(ctx));
  const t2 = test2.body.tiers as Record<string, { ok: boolean; kind?: string }>;
  ok(group, test2.body.ok === false && t2.default.kind === "model-not-found" && !store.recs.get("global")!.verifiedAt && store.recs.get("global")!.lastError?.kind === "model-not-found", "an unknown model is reported 'not found for this key' and the setting is not marked verified");
  // rotation
  const before = store.recs.get("global")!.sealedKey;
  await putProvider(ctx, { apiKey: KEY2 });
  const after = store.recs.get("global")!;
  ok(group, after.sealedKey !== before && after.last4 === KEY2.slice(-4) && openRecord(after, aiEncryptionKey(ENV), { kind: "global" }) === KEY2, "rotating the key overwrites the sealed value");
  ok(group, openRecord(after, aiEncryptionKey(ENV), { kind: "org" }) === null, "ciphertext copied to another scope does not decrypt (AAD binding)");
  // settings-only update keeps the key
  await putProvider(ctx, { dailyTokenCap: 1000, models: { fast: "claude-haiku-5-5" } });
  ok(group, openRecord(store.recs.get("global")!, aiEncryptionKey(ENV), { kind: "global" }) === KEY2 && store.recs.get("global")!.dailyTokenCap === 1000, "a settings-only save keeps the stored key");
  // two concurrent saves end in a valid record
  await Promise.all([putProvider(ctx, { apiKey: KEY }), putProvider(ctx, { apiKey: KEY2 })]);
  const k = openRecord(store.recs.get("global")!, aiEncryptionKey(ENV), { kind: "global" });
  ok(group, k === KEY || k === KEY2, "two tabs saving concurrently end in a valid record");
  ok(group, store.audit.length > 3 && store.audit.every((a) => !JSON.stringify(a).includes("TESTKEY")) && store.audit.every((a) => a.who === "paired-device"), "every write/test appends an audit entry (who, action, outcome) without the key");
  everything.push(JSON.stringify(store.audit), JSON.stringify([...store.recs.values()]));
  const del = rec(await deleteProvider(ctx));
  ok(group, del.status === 200 && !store.recs.has("global"), "remove deletes the stored key");
}

{
  const group = "D1 env vs saved";
  const env: ProviderEnv = { ...ENV, ANTHROPIC_API_KEY: "sk-ant-envkey-ENVENVENV" };
  const ctx = ctxOf({ env });
  const s0 = rec(await getProviderStatus(ctx));
  ok(group, s0.body.source === "env" && s0.body.configured === true, "with only the env key, the source is env");
  await putProvider(ctx, { apiKey: KEY });
  const s1 = rec(await getProviderStatus(ctx));
  ok(group, s1.body.source === "global" && s1.body.overridesEnv === true, "a saved key wins and the panel says it overrides the env");
  await deleteProvider(ctx);
  ok(group, (await getProviderStatus(ctx)).body.source === "env", "Remove falls back to the env key");
  const { creds } = await resolveCredentials({ store: ctx.store, env, scopes: scopesFor({ kind: "legacy" }) });
  ok(group, creds?.source === "env" && modelEnvFor(env, creds).ANTHROPIC_MODEL === undefined, "resolution falls back to env; models fall back to env/defaults");
}

{
  const group = "D1 team mode";
  const store = memStore();
  const mk = (p: ProviderPrincipal) => ctxOf({ store, principal: p });
  const memberA = mk(user("a")), memberB = mk(user("b")), admin = mk(user("admin1", "admin"));
  ok(group, (await putProvider(memberA, { apiKey: KEY })).status === 200, "a member saves their own key");
  ok(group, (await getProviderStatus(memberB)).body.configured === false, "member A's key is not used for member B");
  ok(group, (await putProvider(memberB, { apiKey: KEY2, scope: "org" })).status === 403, "only an admin can write the org key");
  ok(group, (await putProvider(admin, { apiKey: KEY2, scope: "org" })).status === 200, "an admin saves the org key");
  const b = await getProviderStatus(memberB);
  ok(group, b.body.configured === true && b.body.source === "org", "members without their own key use the org key");
  const a = await getProviderStatus(memberA);
  ok(group, a.body.source === "member", "a member's own key beats the org key");
  ok(group, scopeId({ kind: "member", uid: "a" }) === "u:a" && scopesFor({ kind: "user", uid: "a" }).map((s) => s.kind).join() === "member,org", "scopes resolve member -> org");
  ok(group, (await putProvider(memberA, { apiKey: KEY, scope: "weird" })).status === 400, "unknown scope rejected");
}

{
  const group = "D1 failure modes";
  const noKv = ctxOf({ store: null });
  const r1 = rec(await putProvider(noKv, { apiKey: KEY }));
  ok(group, r1.status === 503 && r1.body.errorKind === "kv-unavailable", "KV down -> 503 'cannot save', nothing written");
  const throwing: ProviderStore = { ...memStore(), get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
  ok(group, (await putProvider(ctxOf({ store: throwing }), { apiKey: KEY })).status === 503, "a store that throws -> 503, no crash");
  const r2 = rec(await putProvider(ctxOf({ env: {} }), { apiKey: KEY }));
  ok(group, r2.status === 409 && r2.body.errorKind === "no-key-material", "no encryption material -> read-only with the reason");
  const st = await getProviderStatus(ctxOf({ env: { ANTHROPIC_API_KEY: "sk-ant-x-ENVKEY" } }));
  ok(group, st.body.canStoreKey === false && typeof st.body.missing === "string" && st.body.configured === true, "env mode keeps working when no key material exists; the panel names the variable to set");
  // decrypt failure: a record sealed under another secret
  const store = memStore();
  const c1 = ctxOf({ store });
  await putProvider(c1, { apiKey: KEY });
  const c2 = ctxOf({ store, env: { APP_STATE_SECRET: "a-different-secret-0123456789abcdef" } });
  const s = rec(await getProviderStatus(c2));
  ok(group, s.status === 200 && s.body.configured === false && (s.body.lastError as { kind: string }).kind === "unreadable-stored-key", "decrypt failure -> not configured with lastError, never a crash");
  const t = rec(await testProvider(c2));
  ok(group, t.status === 409, "test without a usable key -> 409 'configure a key first'");
  // SDK failures map to per-tier messages
  const failing = ctxOf({ sdk: { listModels: async () => { throw Object.assign(new Error(`bad ${KEY}`), { status: 401 }); }, ping: async () => undefined } });
  await putProvider(failing, { apiKey: KEY });
  const ft = rec(await testProvider(failing));
  const tiers = ft.body.tiers as Record<string, { kind?: string; message?: string }>;
  ok(group, ft.body.ok === false && tiers.fast.kind === "invalid-key" && tiers.deep.message!.includes("401") && !JSON.stringify(ft).includes("TESTKEY"), "a 401 maps to 'key rejected' on every tier, without leaking the key");
  const pingFail = ctxOf({ sdk: { listModels: async () => ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"], ping: async (_k, m) => { if (m.includes("opus")) throw Object.assign(new Error("x"), { status: 429 }); } } });
  await putProvider(pingFail, { apiKey: KEY });
  const pf = (await testProvider(pingFail)).body.tiers as Record<string, { ok: boolean; kind?: string }>;
  ok(group, pf.fast.ok && pf.default.ok && !pf.deep.ok && pf.deep.kind === "rate-limited", "per-tier results: one tier can fail while the others pass");
}

{
  const group = "D1 rate limit and fields";
  const ctx = ctxOf();
  let last = 200;
  for (let i = 0; i < 11; i++) last = (await putProvider(ctx, { apiKey: KEY })).status;
  ok(group, last === 429, "the 11th write within an hour -> 429");
  const t = ctxOf();
  await putProvider(t, { apiKey: KEY });
  let ts = 200;
  for (let i = 0; i < 21; i++) ts = (await testProvider(t)).status;
  ok(group, ts === 429, "the 21st test within an hour -> 429");
  const c = ctxOf();
  ok(group, (await putProvider(c, { apiKey: "nope" })).status === 400 && (await putProvider(c, { apiKey: KEY, dailyTokenCap: -5 })).status === 400 && (await putProvider(c, { apiKey: KEY, baseUrl: "http://x.example.com" })).status === 400, "validation errors -> 400 with a field message, nothing stored");
  ok(group, (c.store as ReturnType<typeof memStore>).recs.size === 0, "nothing is stored after validation failures");
  ok(group, effectiveCap({ ...ENV, AI_DAILY_TOKEN_CAP: "1000" }, { apiKey: "k", source: "global", fingerprint: "f", models: {}, cap: 5000 }) === 1000 && effectiveCap({ ...ENV, AI_DAILY_TOKEN_CAP: "1000" }, { apiKey: "k", source: "global", fingerprint: "f", models: {}, cap: 300 }) === 300, "effective cap = min(record cap, hard cap)");
}

{
  const group = "D1 readiness states and client";
  const base = { features: { ticketAi: true, ticketBrief: true, smartTriage: true, mentionReplyDrafter: true, audienceReports: true, baRequirementCheck: true, aiBlockerFollowUp: true, releaseGoNoGo: true, meetingNotesActions: true, nlCommands: true, weeklyInsights: true, nextBestActionAi: true }, usage: null, allowedProjectKeys: ["A"], projectKeys: ["A"] };
  const { aiReadiness } = await import("../../src/lib/command-center/ai/readiness");
  const nk = aiReadiness("weeklyInsights", { ...base, ai: { available: false, canStoreKey: true } });
  ok(group, nk.state === "NEEDS_KEY" && /Data & Settings → AI provider/.test(nk.nextStep), "NEEDS_KEY points to the AI provider panel when a key can be stored");
  ok(group, /ANTHROPIC_API_KEY/.test(aiReadiness("weeklyInsights", { ...base, ai: { available: false, canStoreKey: false } }).nextStep), "…and to the env variable otherwise");
  ok(group, aiReadiness("weeklyInsights", { ...base, ai: { available: true, providerError: "invalid-key" } }).state === "KEY_REJECTED" && aiReadiness("weeklyInsights", { ...base, ai: { available: true, providerError: "model-not-found" } }).state === "MODEL_UNAVAILABLE", "KEY_REJECTED / MODEL_UNAVAILABLE states");
  const src = fs.readFileSync("src/lib/command-center/ai/claude-provider.ts", "utf8");
  ok(group, /AI_AVAILABILITY_TTL_MS = 60_000/.test(src) && /export function refreshAiAvailability/.test(src) && /recordAiFailure/.test(src), "the client availability cache has a 60 s TTL, a refresh hook and records error kinds");
}

{
  const group = "D1 secrecy";
  const panel = fs.readFileSync("src/components/command-center/AiProviderPanel.tsx", "utf8");
  ok(group, !/localStorage|sessionStorage|indexedDB/.test(panel) && /setApiKey\(""\)/.test(panel), "the panel never persists the key and clears it after saving");
  const backup = fs.readFileSync("src/lib/command-center/backup.ts", "utf8");
  ok(group, !/ai-provider|apiKey|sealedKey/i.test(backup), "the backup exporter knows nothing about the provider key");
  const routeSrc = fs.readFileSync("src/lib/server/ai-provider-route.ts", "utf8");
  ok(group, /isSameOrigin/.test(routeSrc) && /checkSyncRequestAuth/.test(routeSrc) && /Cache-Control/.test(routeSrc), "provider routes: same-origin for writes, paired/signed-in auth, no-store");
  const blob = everything.join("\n");
  ok(group, !blob.includes("TESTKEY") && !blob.includes("SECONDKEY") && !blob.includes("ENVENVENV") && !blob.includes("abcdef0123456789"), `no response, audit entry, error or stored record in ${everything.length} captures contains a key`);
  const sealed = sealRecord(KEY, aiEncryptionKey(ENV)!, { kind: "global" });
  ok(group, !blob.includes(sealed.sealedKey), "…nor a sealed value");
}
