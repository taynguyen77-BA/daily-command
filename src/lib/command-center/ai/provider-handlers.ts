// D1 — the logic of GET/PUT/DELETE /api/command-center/ai/provider and POST …/provider/test, with every dependency injected
// (store, SDK, clock, env) so it is tested offline with fakes. Routes only do auth + wiring. The key is write-only: no response,
// audit entry, error string or log line produced here ever contains it (errors pass through redactSecrets).

import { resolveTierModels } from "./model-resolution";
import { aiModelStatus, type AiModelTier } from "./model-config";
import {
  aiEncryptionKey, effectiveCap, mapProviderError, describeProviderError, modelEnvFor, providerErrorText, redactSecrets, resolveCredentials, scopeId, scopesFor, sealRecord,
  validateApiKey, validateBaseUrl, validateCap, validateModels,
  type AiProviderErrorKind, type AiProviderRecord, type AuditEntry, type ProviderEnv, type ProviderScope, type ProviderStore,
} from "./provider-config";
import { resolveDailyTokenCap } from "./usage-ledger";

export interface ProviderSdk {
  /** Every model id the key can use. Costs no tokens. */
  listModels(apiKey: string, baseUrl?: string): Promise<string[]>;
  /** One tiny messages call (max_tokens 64): HTTP success is the verdict (stop_reason max_tokens is fine). */
  ping(apiKey: string, model: string, baseUrl?: string): Promise<void>;
}

export type ProviderPrincipal = { kind: "legacy" } | { kind: "user"; uid: string; role: "admin" | "member" };

export class RateLimiter {
  private hits = new Map<string, number[]>();
  /** true = allowed (and counted). */
  take(key: string, limit: number, windowMs: number, now: number): boolean {
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (fresh.length >= limit) { this.hits.set(key, fresh); return false; }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }
}

export interface ProviderCtx {
  store: ProviderStore | null;
  env: ProviderEnv;
  sdk: ProviderSdk;
  now: () => Date;
  principal: ProviderPrincipal;
  limiter: RateLimiter;
}
export type HandlerResult = { status: number; body: Record<string, unknown> };

const HOUR = 3_600_000;
const WRITES_PER_HOUR = 10;
const TESTS_PER_HOUR = 20;
const MAX_AUDIT = 100;
const bad = (status: number, error: string, extra: Record<string, unknown> = {}): HandlerResult => ({ status, body: { ok: false, error: redactSecrets(error), ...extra } });
const who = (p: ProviderPrincipal) => (p.kind === "user" ? p.uid : "paired-device");
/** Custom base URL: the owner (single-user) and team admins may always set one; members need AI_ALLOW_CUSTOM_BASE_URL=true.
 *  AI_ALLOW_CUSTOM_BASE_URL=false switches it off for everyone. Every URL still passes the https / no-private-host checks. */
const customBaseUrlAllowed = (env: ProviderEnv, p?: ProviderPrincipal) => {
  const f = env.AI_ALLOW_CUSTOM_BASE_URL?.trim().toLowerCase();
  if (f === "false") return false;
  return f === "true" || !p || p.kind === "legacy" || p.role === "admin";
};

async function audit(ctx: ProviderCtx, action: AuditEntry["action"], outcome: string, scope: string): Promise<void> {
  try { await ctx.store?.appendAudit({ at: ctx.now().toISOString(), who: who(ctx.principal), action, outcome, scope }); } catch { /* the audit trail must never fail a request */ }
}

/** Which scope a write targets. Team mode: the member, or the org (admins only). Single-user: the global record. */
function writeScope(ctx: ProviderCtx, requested: unknown): { scope: ProviderScope } | { error: HandlerResult } {
  const p = ctx.principal;
  if (p.kind === "legacy") return { scope: { kind: "global" } };
  if (requested === "org") return p.role === "admin" ? { scope: { kind: "org" } } : { error: bad(403, "Only an admin can manage the organization key.") };
  if (requested !== undefined && requested !== "member") return { error: bad(400, "scope must be “member” or “org”.", { field: "scope" }) };
  return { scope: { kind: "member", uid: p.uid } };
}

export async function getProviderStatus(ctx: ProviderCtx): Promise<HandlerResult> {
  const enc = aiEncryptionKey(ctx.env);
  const scopes = scopesFor(ctx.principal);
  const { creds, skipped } = await resolveCredentials({ store: ctx.store, env: ctx.env, scopes });
  let rec: AiProviderRecord | null = null;
  if (creds && creds.source !== "env" && ctx.store) {
    try { rec = await ctx.store.get(scopeId(scopes.find((s) => s.kind === creds.source)!)); } catch { rec = null; }
  }
  const lastError = rec?.lastError ?? (skipped[0] ? { kind: skipped[0].kind, message: providerErrorText(skipped[0].kind), at: ctx.now().toISOString() } : undefined);
  const savedAndEnv = creds?.source !== "env" && Boolean(ctx.env.ANTHROPIC_API_KEY?.trim());
  return {
    status: 200,
    body: {
      ok: true,
      configured: creds !== null,
      source: creds?.source ?? null,
      overridesEnv: savedAndEnv,
      last4: rec?.last4 ?? null,
      fingerprint: creds?.fingerprint ?? null,
      verifiedAt: rec?.verifiedAt ?? null,
      lastError: lastError ?? null,
      canStoreKey: Boolean(enc && ctx.store),
      storeAvailable: ctx.store !== null,
      ...(enc ? {} : { missing: "AUTH_ENCRYPTION_KEY, NEXTAUTH_SECRET or APP_STATE_SECRET" }),
      customBaseUrlAllowed: customBaseUrlAllowed(ctx.env, ctx.principal),
      baseUrl: creds?.baseUrl ?? rec?.baseUrl ?? null,
      models: aiModelStatus(modelEnvFor(ctx.env, creds)),
      savedModels: rec?.models ?? {},
      cap: effectiveCap(ctx.env, creds),
      hardCap: resolveDailyTokenCap(ctx.env.AI_DAILY_TOKEN_CAP),
      ...(ctx.principal.kind === "user" && ctx.principal.role === "admin" ? { canManageOrgKey: true } : {}),
    },
  };
}

export async function putProvider(ctx: ProviderCtx, body: unknown): Promise<HandlerResult> {
  if (!body || typeof body !== "object") return bad(400, "Malformed request body.");
  const b = body as Record<string, unknown>;
  const target = writeScope(ctx, b.scope);
  if ("error" in target) return target.error;
  const scope = target.scope;
  const id = scopeId(scope);
  if (!ctx.limiter.take(`write:${who(ctx.principal)}`, WRITES_PER_HOUR, HOUR, ctx.now().getTime())) return bad(429, "Too many changes in the last hour (limit 10). Try again later.", { errorKind: "rate-limited" });

  const hard = resolveDailyTokenCap(ctx.env.AI_DAILY_TOKEN_CAP);
  const models = validateModels(b.models);
  if (!models.ok) return bad(400, models.message, { field: models.field });
  const cap = validateCap(b.dailyTokenCap, hard);
  if (!cap.ok) return bad(400, cap.message, { field: cap.field });
  const clearBaseUrl = b.baseUrl === "" && customBaseUrlAllowed(ctx.env, ctx.principal); // an empty field removes a saved URL
  const baseUrl = validateBaseUrl(b.baseUrl, customBaseUrlAllowed(ctx.env, ctx.principal));
  if (!baseUrl.ok) return bad(400, baseUrl.message, { field: baseUrl.field });
  let key: string | undefined;
  if (b.apiKey !== undefined) {
    const k = validateApiKey(b.apiKey, true); // format only; the sk-ant- prefix is enforced below unless a gateway URL is in play
    if (!k.ok) return bad(400, k.message, { field: k.field });
    key = k.value;
  }

  const enc = aiEncryptionKey(ctx.env);
  if (!enc) return bad(409, providerErrorText("no-key-material"), { errorKind: "no-key-material" });
  if (!ctx.store) return bad(503, providerErrorText("kv-unavailable"), { errorKind: "kv-unavailable" });

  try {
    const existing = await ctx.store.get(id);
    if (!key && !existing) return bad(400, "Paste your API key first.", { field: "apiKey" });
    const effectiveBase = clearBaseUrl ? undefined : (baseUrl.value ?? existing?.baseUrl);
    if (key && !effectiveBase && !key.startsWith("sk-ant-")) return bad(400, "Anthropic keys start with “sk-ant-”. For a custom gateway, enter its base URL too.", { field: "apiKey" });
    const now = ctx.now();
    const common = { savedBy: who(ctx.principal), ...(Object.keys(models.value).length ? { models: models.value } : {}), ...(cap.value !== undefined ? { dailyTokenCap: cap.value } : {}), ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}) };
    // A new key overwrites the old sealed value and resets verification; settings-only changes keep the stored key.
    const rec: AiProviderRecord = key ? sealRecord(key, enc, scope, common, now) : { ...existing!, ...common, savedAt: now.toISOString() };
    if (clearBaseUrl) delete rec.baseUrl;
    await ctx.store.put(id, rec);
    await audit(ctx, "save", key ? "key saved" : "settings saved", id);
    return { status: 200, body: { ok: true, last4: rec.last4, fingerprint: rec.fingerprint, savedAt: rec.savedAt, scope: scope.kind } };
  } catch {
    await audit(ctx, "save", "kv-unavailable", id);
    return bad(503, providerErrorText("kv-unavailable"), { errorKind: "kv-unavailable" });
  }
}

export async function deleteProvider(ctx: ProviderCtx, body?: unknown): Promise<HandlerResult> {
  const requested = body && typeof body === "object" ? (body as Record<string, unknown>).scope : undefined;
  const target = writeScope(ctx, requested);
  if ("error" in target) return target.error;
  const id = scopeId(target.scope);
  if (!ctx.limiter.take(`write:${who(ctx.principal)}`, WRITES_PER_HOUR, HOUR, ctx.now().getTime())) return bad(429, "Too many changes in the last hour (limit 10). Try again later.", { errorKind: "rate-limited" });
  if (!ctx.store) return bad(503, providerErrorText("kv-unavailable"), { errorKind: "kv-unavailable" });
  try {
    await ctx.store.del(id);
    await audit(ctx, "remove", "key removed", id);
    return { status: 200, body: { ok: true } };
  } catch {
    return bad(503, providerErrorText("kv-unavailable"), { errorKind: "kv-unavailable" });
  }
}

export interface TierTest { ok: boolean; model: string; ms?: number; kind?: AiProviderErrorKind; message?: string }

export async function testProvider(ctx: ProviderCtx): Promise<HandlerResult> {
  if (!ctx.limiter.take(`test:${who(ctx.principal)}`, TESTS_PER_HOUR, HOUR, ctx.now().getTime())) return bad(429, "Too many tests in the last hour (limit 20). Try again later.", { errorKind: "rate-limited" });
  const scopes = scopesFor(ctx.principal);
  const { creds } = await resolveCredentials({ store: ctx.store, env: ctx.env, scopes });
  if (!creds) return bad(409, "Configure a key first.", { errorKind: "no-key" });
  const modelEnv = modelEnvFor(ctx.env, creds);
  const status = aiModelStatus(modelEnv);
  const tierModel: Record<AiModelTier, string> = { fast: status.fastModel, default: status.model, deep: status.deepModel };
  const tiers: Record<string, TierTest> = {};
  let available: string[] | null = null;
  let listError: { kind: AiProviderErrorKind; message: string } | null = null;
  try {
    available = await ctx.sdk.listModels(creds.apiKey, creds.baseUrl);
  } catch (err) {
    const m = describeProviderError(err, Boolean(creds.baseUrl));
    listError = { kind: m.kind, message: m.message };
  }
  // A gateway may not implement models.list() or may use its own ids: never let that block the real one-call check.
  const gateway = Boolean(creds.baseUrl);
  // Gateway: it only serves the models it lists, so tiers the user never chose follow that list (and are remembered below).
  const auto: Partial<Record<AiModelTier, string>> = {};
  if (gateway && available && available.length > 0) {
    const rs = resolveTierModels({ configured: tierModel, userChosen: creds.models, available });
    for (const tier of ["fast", "default", "deep"] as const) if (rs[tier].autoSelected) { tierModel[tier] = rs[tier].model; auto[tier] = rs[tier].model; }
  }
  const listedHint = gateway && available && available.length > 0 ? ` Models this gateway lists: ${available.slice(0, 8).join(", ")}${available.length > 8 ? ", …" : ""}.` : "";
  for (const tier of ["fast", "default", "deep"] as const) {
    const model = tierModel[tier];
    if (listError && !gateway) { tiers[tier] = { ok: false, model, kind: listError.kind, message: listError.message }; continue; }
    if (available && !gateway && !available.includes(model)) { tiers[tier] = { ok: false, model, kind: "model-not-found", message: providerErrorText("model-not-found") }; continue; }
    const t0 = ctx.now().getTime();
    try {
      await ctx.sdk.ping(creds.apiKey, model, creds.baseUrl);
      tiers[tier] = { ok: true, model, ms: Math.max(0, ctx.now().getTime() - t0) };
    } catch (err) {
      const m = describeProviderError(err, gateway);
      const notListed = gateway && available && available.length > 0 && !available.includes(model);
      tiers[tier] = { ok: false, model, kind: m.kind, message: notListed ? `${m.message}${listedHint}` : m.message };
    }
  }
  const allOk = Object.values(tiers).every((t) => t.ok);
  // Remember the verdict on the saved record (never for an env key: there is nothing stored to update).
  if (creds.source !== "env" && ctx.store) {
    const scope = scopes.find((s) => s.kind === creds.source)!;
    try {
      const rec = await ctx.store.get(scopeId(scope));
      if (rec) {
        const firstErr = Object.values(tiers).find((t) => !t.ok);
        const next: AiProviderRecord = { ...rec };
        if (Object.keys(auto).length) next.models = { ...(rec.models ?? {}), ...auto }; // remember what followed the gateway's list
        if (allOk) { next.verifiedAt = ctx.now().toISOString(); delete next.lastError; }
        else { delete next.verifiedAt; next.lastError = { kind: firstErr!.kind ?? "unknown", message: firstErr!.message ?? "", at: ctx.now().toISOString() }; }
        await ctx.store.put(scopeId(scope), next);
      }
    } catch { /* best effort */ }
  }
  await audit(ctx, "test", allOk ? "all tiers ok" : `failed: ${Object.values(tiers).filter((t) => !t.ok).map((t) => t.kind).join(",")}`, creds.source);
  return { status: 200, body: { ok: allOk, source: creds.source, tiers, models: (available ?? []).slice(0, 200), ...(listError ? { listError } : {}), ...(creds.baseUrl ? { gateway: creds.baseUrl } : {}), ...(Object.keys(auto).length ? { autoSelected: auto } : {}) } };
}

export async function listProviderAudit(ctx: ProviderCtx): Promise<AuditEntry[]> {
  try { return (await ctx.store?.listAudit()) ?? []; } catch { return []; }
}
export const AUDIT_LIMIT = MAX_AUDIT;
