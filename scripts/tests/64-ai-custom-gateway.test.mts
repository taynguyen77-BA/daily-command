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

{
  const group = "V2.48.2 models follow the gateway";
  const { pickModelForTier, resolveTierModels } = await import("../../src/lib/command-center/ai/model-resolution");
  const { validateModels } = await import("../../src/lib/command-center/ai/provider-config");
  const list = ["claude-sonnet-4-5", "claude-sonnet-4-20250514", "claude-haiku-4-5", "claude-opus-4-1", "gpt-x"];
  ok(group, pickModelForTier("fast", list) === "claude-haiku-4-5" && pickModelForTier("default", list) === "claude-sonnet-4-5" && pickModelForTier("deep", list) === "claude-opus-4-1", "tiers map to haiku / sonnet / opus, highest version wins (date stamps ignored)");
  ok(group, pickModelForTier("deep", ["gpt-4o", "gpt-5"]) === "gpt-5" && pickModelForTier("fast", []) === null, "no matching family -> best listed model; empty list -> null");
  const cfg = { fast: "claude-haiku-5-5", default: "claude-sonnet-5-5", deep: "claude-opus-5-5" };
  const r = resolveTierModels({ configured: cfg, userChosen: {}, available: list });
  ok(group, r.fast.model === "claude-haiku-4-5" && r.default.autoSelected && r.deep.model === "claude-opus-4-1", "unlisted default models are replaced from the list");
  const r2 = resolveTierModels({ configured: { ...cfg, default: "my-model" }, userChosen: { default: "my-model" }, available: list });
  ok(group, r2.default.model === "my-model" && !r2.default.autoSelected, "a model the user chose is never silently replaced");
  const r3 = resolveTierModels({ configured: cfg, userChosen: {}, available: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] });
  ok(group, Object.values(r3).every((x) => !x.autoSelected), "listed models are kept as they are");
  ok(group, validateModels({ default: "anthropic/claude-sonnet-4.5" }).ok && validateModels({ fast: "model:v1@x" }).ok && !validateModels({ fast: "has space" }).ok, "gateway-style ids (slash, colon, @) accepted; spaces rejected");

  // end to end: gateway lists only older ids, a forbidden id is auto-replaced, saved and used by the next resolution
  const recs = new Map<string, AiProviderRecord>();
  const store: ProviderStore = { get: async (id) => (recs.has(id) ? JSON.parse(JSON.stringify(recs.get(id))) : null), put: async (id, x) => void recs.set(id, JSON.parse(JSON.stringify(x))), del: async (id) => void recs.delete(id), appendAudit: async () => {}, listAudit: async () => [] };
  const pinged: string[] = [];
  const sdk: ProviderSdk = { listModels: async () => list.slice(0, 4), ping: async (_k, m) => { pinged.push(m); if (!list.includes(m)) throw Object.assign(new Error("403"), { status: 403 }); } };
  const env: ProviderEnv = { APP_STATE_SECRET: "paired-secret-for-tests-0123456789" };
  const c: ProviderCtx = { store, env, sdk, now: () => new Date("2026-11-06T09:00:00Z"), principal: { kind: "legacy" }, limiter: new RateLimiter() };
  await putProvider(c, { apiKey: "gw-key-0123456789", baseUrl: "https://aiproviders.s3corp.com.vn/v1" });
  const t = await testProvider(c);
  ok(group, t.body.ok === true && JSON.stringify(t.body.autoSelected) === JSON.stringify({ fast: "claude-haiku-4-5", default: "claude-sonnet-4-5", deep: "claude-opus-4-1" }) && pinged.every((m) => list.includes(m)), "test auto-selects supported models and they all pass");
  const st = (await getProviderStatus(c)).body as { savedModels: Record<string, string>; verifiedAt: string | null };
  ok(group, st.savedModels.default === "claude-sonnet-4-5" && st.verifiedAt !== null, "the chosen models are saved and the connection is marked verified");
  const t2 = await testProvider({ ...c, limiter: new RateLimiter(), sdk: { ...sdk, listModels: async () => list.slice(0, 4) } });
  ok(group, t2.body.ok === true && t2.body.autoSelected === undefined, "second test: nothing left to auto-select");
}

{
  const group = "V2.48.3 gateway auth style";
  const mk = (accepts: (m: string) => boolean) => {
    const recs = new Map<string, AiProviderRecord>();
    const store: ProviderStore = { get: async (id) => (recs.has(id) ? JSON.parse(JSON.stringify(recs.get(id))) : null), put: async (id, x) => void recs.set(id, JSON.parse(JSON.stringify(x))), del: async (id) => void recs.delete(id), appendAudit: async () => {}, listAudit: async () => [] };
    const seen: string[] = [];
    const rej = () => Object.assign(new Error('401 {"error":"API key required for remote API access"}'), { status: 401, error: { error: "API key required for remote API access" } });
    const sdk: ProviderSdk = {
      listModels: async (_k, _b, m) => { seen.push(`list:${m}`); if (!accepts(m ?? "both")) throw rej(); return ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]; },
      ping: async (_k, _m, _b, m) => { seen.push(`ping:${m}`); if (!accepts(m ?? "both")) throw rej(); },
    };
    const c: ProviderCtx = { store, env: { APP_STATE_SECRET: "paired-secret-for-tests-0123456789" }, sdk, now: () => new Date("2026-11-06T09:00:00Z"), principal: { kind: "legacy" }, limiter: new RateLimiter() };
    return { c, seen };
  };
  const GW = "https://aiproviders.s3corp.com.vn/v1";

  const a = mk((m) => m === "bearer");
  await putProvider(a.c, { apiKey: "gw-key-0123456789", baseUrl: GW });
  const ta = await testProvider(a.c);
  ok(group, ta.body.ok === true && ta.body.authMode === "bearer", "a gateway that only takes Bearer: the 401 on 'both' is retried and Bearer found");
  const sa = await getProviderStatus(a.c);
  const credsA = await resolveCredentials({ store: a.c.store, env: a.c.env, scopes: [{ kind: "global" }] });
  ok(group, sa.body.verifiedAt !== null && credsA.creds?.authMode === "bearer", "the working style is saved and used for real AI calls");

  const b = mk(() => false);
  await putProvider(b.c, { apiKey: "gw-key-0123456789", baseUrl: GW });
  const tb = await testProvider(b.c);
  const msgB = String((tb.body.tiers as Record<string, { message?: string }>).default.message);
  ok(group, tb.body.ok === false && msgB.includes("x-api-key, as a Bearer token and as both") && msgB.includes("Gateway said"), "every style rejected -> an honest message saying the key itself is not accepted");

  const c2 = mk((m) => m === "both");
  await putProvider(c2.c, { apiKey: "gw-key-0123456789", baseUrl: GW });
  const tc = await testProvider(c2.c);
  ok(group, tc.body.ok === true && tc.body.authMode === "both" && !c2.seen.some((x) => x.endsWith("api-key") || x.endsWith("bearer")), "the default style that works is not probed against");

  ok(group, validateApiKey('  "Bearer gw-key-0123456789"  ', true).ok && (validateApiKey('Bearer gw-key-0123456789', true) as { value: string }).value === "gw-key-0123456789", "a pasted key with quotes / a Bearer prefix is cleaned");
  const plain = await resolveCredentials({ store: null, env: { ANTHROPIC_API_KEY: "sk-ant-x" }, scopes: [{ kind: "global" }] });
  ok(group, plain.creds?.authMode === undefined, "no gateway -> no auth mode, previous behaviour");
}
