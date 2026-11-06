// V2.48.1 — custom Anthropic-compatible gateway (ANTHROPIC_BASE_URL): "/v1" normalised, env honoured, gateway key format accepted.
import { ok } from "./harness.mts";
import { describeProviderError, resolveCredentials, validateApiKey, validateBaseUrl, type AiProviderRecord, type AuditEntry, type ProviderEnv, type ProviderStore } from "../../src/lib/command-center/ai/provider-config";
import { RateLimiter, getProviderStatus, putProvider, testProvider, type ProviderCtx, type ProviderPrincipal, type ProviderSdk } from "../../src/lib/command-center/ai/provider-handlers";

{
  const group = "V2.48.1 custom gateway";
  const v = (u: string) => { const r = validateBaseUrl(u, true); return r.ok ? r.value : null; };
  ok(group, v("https://aiproviders.s3corp.com.vn/v1") === "https://aiproviders.s3corp.com.vn", "trailing /v1 stripped (the SDK appends /v1/messages)");
  ok(group, v("https://aiproviders.s3corp.com.vn/v1/") === "https://aiproviders.s3corp.com.vn" && v("https://aiproviders.s3corp.com.vn") === "https://aiproviders.s3corp.com.vn", "trailing slash and bare origin handled");
  ok(group, v("https://gw.example.com/anthropic/v1") === "https://gw.example.com/anthropic" && v("https://gw.example.com/anthropic") === "https://gw.example.com/anthropic", "a path prefix is kept");
  ok(group, v("http://aiproviders.s3corp.com.vn/v1") === null && v("https://10.0.0.1/v1") === null, "http and private hosts still rejected");

  ok(group, !validateApiKey("gw-key-123456").ok && validateApiKey("gw-key-123456", true).ok, "non sk-ant key accepted only with a custom base URL");
  ok(group, !validateApiKey("bad key", true).ok, "whitespace still rejected for gateway keys");

  const env = (over: Partial<ProviderEnv>): ProviderEnv => ({ ANTHROPIC_API_KEY: "gw-key-123456", ...over });
  const r1 = await resolveCredentials({ store: null, env: env({ ANTHROPIC_BASE_URL: "https://aiproviders.s3corp.com.vn/v1" }), scopes: [{ kind: "global" }] });
  ok(group, r1.creds?.source === "env" && r1.creds.baseUrl === "https://aiproviders.s3corp.com.vn", "ANTHROPIC_BASE_URL honoured for the env key (no AI_ALLOW_CUSTOM_BASE_URL needed)");
  const r2 = await resolveCredentials({ store: null, env: env({}), scopes: [{ kind: "global" }] });
  ok(group, r2.creds?.baseUrl === undefined, "no ANTHROPIC_BASE_URL -> default Anthropic endpoint (previous behaviour)");
  const r3 = await resolveCredentials({ store: null, env: env({ ANTHROPIC_BASE_URL: "http://169.254.169.254" }), scopes: [{ kind: "global" }] });
  ok(group, r3.creds?.baseUrl === undefined, "an unsafe ANTHROPIC_BASE_URL is ignored, never used");
}

{
  const group = "V2.48.1 connect from Data & Settings";
  const recs = new Map<string, AiProviderRecord>();
  const store: ProviderStore = { get: async (id) => (recs.has(id) ? JSON.parse(JSON.stringify(recs.get(id))) : null), put: async (id, r) => void recs.set(id, JSON.parse(JSON.stringify(r))), del: async (id) => void recs.delete(id), appendAudit: async (_e: AuditEntry) => {}, listAudit: async () => [] };
  const calls: { op: string; base?: string }[] = [];
  const sdk = (over: Partial<ProviderSdk> = {}): ProviderSdk => ({ listModels: async (_k, b) => { calls.push({ op: "list", base: b }); return ["gw-model"]; }, ping: async (_k, _m, b) => void calls.push({ op: "ping", base: b }), ...over });
  const env: ProviderEnv = { APP_STATE_SECRET: "paired-secret-for-tests-0123456789" };
  const ctx = (principal: ProviderPrincipal, e: ProviderEnv = env, s = sdk()): ProviderCtx => ({ store, env: e, sdk: s, now: () => new Date("2026-11-06T09:00:00Z"), principal, limiter: new RateLimiter() });
  const GW = "https://aiproviders.s3corp.com.vn/v1";

  const st0 = (await getProviderStatus(ctx({ kind: "legacy" }))).body;
  ok(group, st0.customBaseUrlAllowed === true, "single-user owner sees the base URL field without any env flag");
  ok(group, (await getProviderStatus(ctx({ kind: "user", uid: "m1", role: "member" }))).body.customBaseUrlAllowed === false && (await getProviderStatus(ctx({ kind: "user", uid: "a1", role: "admin" }))).body.customBaseUrlAllowed === true, "team: admin yes, plain member no");
  ok(group, (await getProviderStatus(ctx({ kind: "legacy" }, { ...env, AI_ALLOW_CUSTOM_BASE_URL: "false" }))).body.customBaseUrlAllowed === false, "AI_ALLOW_CUSTOM_BASE_URL=false switches it off");

  const saved = await putProvider(ctx({ kind: "legacy" }), { apiKey: "gw-key-0123456789", baseUrl: GW });
  ok(group, saved.status === 200 && (await getProviderStatus(ctx({ kind: "legacy" }))).body.baseUrl === "https://aiproviders.s3corp.com.vn", "gateway key (no sk-ant prefix) + base URL saved, /v1 normalised");
  ok(group, (await putProvider(ctx({ kind: "legacy" }), { apiKey: "gw-key-0123456789", baseUrl: "" })).status === 400, "a non sk-ant key without any gateway URL is still refused");
  ok(group, (await putProvider(ctx({ kind: "legacy" }), { models: { fast: "gw-model" } })).status === 200 && (await getProviderStatus(ctx({ kind: "legacy" }))).body.baseUrl === "https://aiproviders.s3corp.com.vn", "a settings-only save keeps the saved URL");

  calls.length = 0;
  const t = await testProvider(ctx({ kind: "legacy" }));
  ok(group, calls.every((c) => c.base === "https://aiproviders.s3corp.com.vn") && calls.some((c) => c.op === "ping"), "the test calls go to the gateway");
  ok(group, Object.values((t.body.tiers ?? {}) as Record<string, { ok: boolean }>).every((x) => x.ok), "a model id missing from the gateway's list does not fail the tier (it is pinged for real)");

  const t2 = await testProvider(ctx({ kind: "legacy" }, env, sdk({ listModels: async () => { throw Object.assign(new Error("404 not found"), { status: 404 }); } })));
  ok(group, Object.values((t2.body.tiers ?? {}) as Record<string, { ok: boolean }>).every((x) => x.ok), "a gateway without models.list() still passes when the ping works");

  const t3 = await testProvider(ctx({ kind: "legacy" }, env, sdk({ ping: async () => { throw Object.assign(new Error("401 {\"error\":\"API key required for remote API access\"}"), { status: 401, error: { error: "API key required for remote API access" } }); } })));
  const msg = String(((t3.body.tiers ?? {}) as Record<string, { message?: string }>).default?.message ?? "");
  ok(group, msg.includes("Gateway said") && msg.includes("API key required") && !msg.includes("Anthropic"), "a gateway 401 quotes the gateway's own message");
  ok(group, !describeProviderError({ status: 401 }, false).message.includes("Gateway said"), "no gateway wording for the default endpoint");

  ok(group, (await putProvider(ctx({ kind: "legacy" }), { baseUrl: "" })).status === 200 && (await getProviderStatus(ctx({ kind: "legacy" }))).body.baseUrl === null, "an empty URL field removes the saved base URL");
}
