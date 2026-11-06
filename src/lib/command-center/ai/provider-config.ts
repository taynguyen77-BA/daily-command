// D1 — AI provider configuration: pure rules (validation, error-kind mapping, secret redaction, credential resolution).
// The API key is WRITE-ONLY: it is sealed with AES-256-GCM (auth/secret-box.ts, AAD = scope id) before it is stored, and it is
// never returned, logged or put in client state. Everything here is offline-testable; I/O lives in provider-handlers.ts and
// lib/server/ai-provider-store.ts.

import { createHash, hkdfSync } from "node:crypto";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../auth/secret-box";
import type { AiModelEnv, AiModelTier } from "./model-config";
import { resolveDailyTokenCap } from "./usage-ledger";

export type ProviderScope = { kind: "global" } | { kind: "member"; uid: string } | { kind: "org" };
export type ProviderSource = "member" | "org" | "global" | "env";

export const scopeId = (s: ProviderScope): string => (s.kind === "global" ? "global" : s.kind === "org" ? "org" : `u:${s.uid}`);

export interface AiProviderRecord {
  provider: "anthropic";
  sealedKey: string;
  last4: string;
  /** First 8 hex of sha256(key) — identifies a key without revealing it. */
  fingerprint: string;
  savedAt: string;
  savedBy?: string;
  verifiedAt?: string;
  lastError?: { kind: AiProviderErrorKind; message: string; at: string };
  models?: Partial<Record<AiModelTier, string>>;
  dailyTokenCap?: number;
  baseUrl?: string;
}

export type AiProviderErrorKind = "invalid-key" | "permission" | "model-not-found" | "rate-limited" | "provider-down" | "timeout" | "network" | "unreadable-stored-key" | "kv-unavailable" | "no-key-material" | "refused" | "unknown";

const ERROR_TEXT: Record<AiProviderErrorKind, string> = {
  "invalid-key": "The API key was rejected (401). Check that it is a valid, active Anthropic key.",
  permission: "The key is valid but not allowed to do this (403). Check the workspace permissions of the key.",
  "model-not-found": "That model id was not found for this key (404). Pick a model from the list or check the spelling.",
  "rate-limited": "Rate limit or credit balance reached (429). Wait a moment, or check your Anthropic plan and credits.",
  "provider-down": "The Anthropic API had a server error (5xx). Try again shortly.",
  timeout: "The request to Anthropic timed out. Try again.",
  network: "Could not reach the Anthropic API (network error).",
  "unreadable-stored-key": "The saved key could not be decrypted (the encryption secret changed?). Save the key again.",
  "kv-unavailable": "Cannot save: the server's key-value store is not reachable.",
  "no-key-material": "Cannot store a key: set AUTH_ENCRYPTION_KEY (or NEXTAUTH_SECRET, or APP_STATE_SECRET) on the server first.",
  refused: "The model declined the test request.",
  unknown: "The provider call failed for an unknown reason.",
};
export const providerErrorText = (k: AiProviderErrorKind): string => ERROR_TEXT[k];

/** For a custom gateway the Anthropic wording is misleading, so name it and quote what it said (redacted, one line, <= 160 chars). */
export function describeProviderError(err: unknown, gateway: boolean): { kind: AiProviderErrorKind; message: string; httpStatus?: number } {
  const m = mapProviderError(err);
  if (!gateway) return m;
  const e = err as { error?: { error?: { message?: unknown }; message?: unknown } | string; message?: unknown } | null;
  const inner = typeof e?.error === "string" ? e.error : (e?.error?.error?.message ?? e?.error?.message ?? e?.message);
  const detail = redactSecrets(String(inner ?? "")).replace(/\s+/g, " ").trim().slice(0, 160);
  const base = m.message.replace(/Anthropic/g, "the gateway");
  return { ...m, message: detail ? `${base} Gateway said: “${detail}”.` : base };
}

/** Never let a key out through an error string, a log line or a trace. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-key]");
}

/** HTTP status / error shape from the SDK (or a fake) -> a plain-language kind. */
export function mapProviderError(err: unknown): { kind: AiProviderErrorKind; message: string; httpStatus?: number } {
  const e = err as { status?: unknown; name?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const name = String(e?.name ?? "");
  const code = String(e?.code ?? "");
  const text = `${name} ${code} ${String(e?.message ?? "")}`;
  let kind: AiProviderErrorKind = "unknown";
  if (status === 401) kind = "invalid-key";
  else if (status === 403) kind = "permission";
  else if (status === 404) kind = "model-not-found";
  else if (status === 429) kind = "rate-limited";
  else if (status !== undefined && status >= 500) kind = "provider-down";
  else if (/timeout|timed out|ETIMEDOUT|abort/i.test(text)) kind = "timeout";
  else if (/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|connection/i.test(text)) kind = "network";
  return { kind, message: ERROR_TEXT[kind], ...(status !== undefined ? { httpStatus: status } : {}) };
}

// ----- validation -----
export type Validation<T> = { ok: true; value: T } | { ok: false; field: string; message: string };

/** `custom`: a custom gateway (base URL) issues its own key format, so the Anthropic "sk-ant-" prefix is not required. */
export function validateApiKey(raw: unknown, custom = false): Validation<string> {
  if (typeof raw !== "string") return { ok: false, field: "apiKey", message: "The API key must be text." };
  const key = raw.trim();
  if (key === "") return { ok: false, field: "apiKey", message: "Paste your Anthropic API key." };
  if (key.length > 300) return { ok: false, field: "apiKey", message: "That is too long to be an API key (max 300 characters)." };
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return { ok: false, field: "apiKey", message: "The key must not contain spaces, line breaks or control characters." };
  if (!custom && !key.startsWith("sk-ant-")) return { ok: false, field: "apiKey", message: "Anthropic keys start with “sk-ant-”." };
  return { ok: true, value: key };
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,99}$/; // gateways often use ids like "anthropic/claude-sonnet-4" or "model:v1"
export function validateModels(raw: unknown): Validation<Partial<Record<AiModelTier, string>>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "models", message: "models must be an object with fast / default / deep." };
  const out: Partial<Record<AiModelTier, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== "fast" && k !== "default" && k !== "deep") return { ok: false, field: "models", message: `Unknown tier “${k}”.` };
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !MODEL_ID.test(v.trim())) return { ok: false, field: `models.${k}`, message: "A model id is letters, digits and . _ : / @ + - (3-100 characters, no spaces). Pick one from the list the gateway returns." };
    out[k] = v.trim();
  }
  return { ok: true, value: out };
}

export function validateCap(raw: unknown, hardCap: number): Validation<number | undefined> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return { ok: false, field: "dailyTokenCap", message: "The daily budget must be a whole number of tokens, 0 or more." };
  if (raw > hardCap) return { ok: false, field: "dailyTokenCap", message: `The daily budget cannot exceed the server's hard cap (${hardCap.toLocaleString("en-US")} tokens).` };
  return { ok: true, value: raw };
}

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
/** A custom base URL is honoured only when allowed; https only; no credentials; no localhost / private / link-local / metadata hosts
 *  (a hostname that RESOLVES to a private address is a documented residual risk — DNS is not resolved here). */
export function validateBaseUrl(raw: unknown, allowed: boolean): Validation<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (!allowed) return { ok: false, field: "baseUrl", message: "A custom base URL is not allowed on this server (AI_ALLOW_CUSTOM_BASE_URL is not true)." };
  if (typeof raw !== "string") return { ok: false, field: "baseUrl", message: "The base URL must be text." };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, field: "baseUrl", message: "That is not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, field: "baseUrl", message: "The base URL must use https." };
  if (u.username || u.password) return { ok: false, field: "baseUrl", message: "The base URL must not contain credentials." };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") return { ok: false, field: "baseUrl", message: "Local and internal hosts are not allowed." };
  if (PRIVATE_V4.test(host) || host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || /^::ffff:/.test(host)) return { ok: false, field: "baseUrl", message: "Private, loopback and link-local addresses are not allowed." };
  // The Anthropic SDK appends /v1/messages itself, so a pasted ".../v1" (the form gateways document) would call /v1/v1/messages.
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return { ok: true, value: u.origin + path };
}

// ----- key sealing -----
export type KeyEnv = { AUTH_ENCRYPTION_KEY?: string; NEXTAUTH_SECRET?: string; APP_STATE_SECRET?: string };

/** The encryption key: the team-mode key (AUTH_ENCRYPTION_KEY / NEXTAUTH_SECRET) or, single-user, HKDF(APP_STATE_SECRET). null = cannot store a key. */
export function aiEncryptionKey(env: KeyEnv): Buffer | null {
  const teamKey = resolveEncryptionKey(env);
  if (teamKey) return teamKey;
  const s = env.APP_STATE_SECRET?.trim();
  return s ? Buffer.from(hkdfSync("sha256", s, "daily-command", "daily-command ai-provider v1", 32)) : null;
}

const aad = (id: string) => `ai-provider:${id}`;
export const fingerprintOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 8);

export function sealRecord(key: string, enc: Buffer, scope: ProviderScope, extra: Partial<AiProviderRecord> = {}, now = new Date()): AiProviderRecord {
  return { provider: "anthropic", sealedKey: encryptSecret(key, enc, aad(scopeId(scope))), last4: key.slice(-4), fingerprint: fingerprintOf(key), savedAt: now.toISOString(), ...extra };
}
export const openRecord = (rec: AiProviderRecord, enc: Buffer | null, scope: ProviderScope): string | null => decryptSecret(rec.sealedKey, enc, aad(scopeId(scope)));

// ----- resolution -----
export interface ResolvedCredentials {
  apiKey: string;
  source: ProviderSource;
  fingerprint: string;
  models: Partial<Record<AiModelTier, string>>;
  cap?: number;
  baseUrl?: string;
}
export interface ProviderEnv extends KeyEnv, AiModelEnv { ANTHROPIC_API_KEY?: string; ANTHROPIC_BASE_URL?: string; AI_DAILY_TOKEN_CAP?: string; AI_ALLOW_CUSTOM_BASE_URL?: string }

export interface ProviderStore {
  get(id: string): Promise<AiProviderRecord | null>;
  put(id: string, rec: AiProviderRecord): Promise<void>;
  del(id: string): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
}
export interface AuditEntry { at: string; who: string; action: "save" | "test" | "remove"; outcome: string; scope: string }

/** member -> org -> (single-user) global -> env. A record that cannot be decrypted is skipped and reported, never a crash. */
export async function resolveCredentials(args: { store: ProviderStore | null; env: ProviderEnv; scopes: ProviderScope[] }): Promise<{ creds: ResolvedCredentials | null; skipped: { source: ProviderSource; kind: AiProviderErrorKind }[] }> {
  const skipped: { source: ProviderSource; kind: AiProviderErrorKind }[] = [];
  const enc = aiEncryptionKey(args.env);
  for (const scope of args.scopes) {
    let rec: AiProviderRecord | null = null;
    try { rec = args.store ? await args.store.get(scopeId(scope)) : null; } catch { skipped.push({ source: scope.kind, kind: "kv-unavailable" }); continue; }
    if (!rec) continue;
    const key = openRecord(rec, enc, scope);
    if (!key) { skipped.push({ source: scope.kind, kind: "unreadable-stored-key" }); continue; }
    return { creds: { apiKey: key, source: scope.kind, fingerprint: rec.fingerprint, models: rec.models ?? {}, ...(rec.dailyTokenCap !== undefined ? { cap: rec.dailyTokenCap } : {}), ...(rec.baseUrl ? { baseUrl: rec.baseUrl } : {}) }, skipped };
  }
  const envKey = args.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) {
    // ANTHROPIC_BASE_URL is operator-set, so it needs no AI_ALLOW_CUSTOM_BASE_URL — but it gets the same https / SSRF checks.
    const bu = validateBaseUrl(args.env.ANTHROPIC_BASE_URL?.trim(), true);
    return { creds: { apiKey: envKey, source: "env", fingerprint: fingerprintOf(envKey), models: {}, ...(bu.ok && bu.value ? { baseUrl: bu.value } : {}) }, skipped };
  }
  return { creds: null, skipped };
}

/** Models: the saved record beats ANTHROPIC_MODEL_* env beats the defaults. */
export function modelEnvFor(env: ProviderEnv, creds: ResolvedCredentials | null): AiModelEnv {
  return {
    ANTHROPIC_MODEL: creds?.models.default ?? env.ANTHROPIC_MODEL,
    ANTHROPIC_MODEL_FAST: creds?.models.fast ?? env.ANTHROPIC_MODEL_FAST,
    ANTHROPIC_MODEL_DEEP: creds?.models.deep ?? env.ANTHROPIC_MODEL_DEEP,
  };
}

/** Effective cap = min(record cap, server hard cap). */
export function effectiveCap(env: ProviderEnv, creds: ResolvedCredentials | null): number {
  const hard = resolveDailyTokenCap(env.AI_DAILY_TOKEN_CAP);
  return creds?.cap !== undefined ? Math.min(creds.cap, hard) : hard;
}

/** The scopes to try for a caller, in order. Single-user: global. Team: the member, then the org. */
export function scopesFor(principal: { kind: "legacy" } | { kind: "user"; uid: string }): ProviderScope[] {
  return principal.kind === "user" ? [{ kind: "member", uid: principal.uid }, { kind: "org" }] : [{ kind: "global" }];
}
