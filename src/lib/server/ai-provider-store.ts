// D1 — server bindings for the AI provider: the KV-backed ProviderStore (sealed records per scope + a bounded audit list), the real
// Anthropic SDK adapter (models.list() + one tiny call), and credential resolution for a request. Server-only.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { directoryKv } from "./kv-client";
import type { KvLike } from "../command-center/kv/kv";
import { mapProviderError, redactSecrets, resolveCredentials, scopesFor, type AiProviderRecord, type AuditEntry, type ProviderEnv, type ProviderStore, type ResolvedCredentials } from "../command-center/ai/provider-config";
import { RateLimiter, type ProviderPrincipal, type ProviderSdk } from "../command-center/ai/provider-handlers";

export const AI_PROVIDER_KEY = (id: string) => `daily-command:ai-provider:v1:${id}`;
export const AI_PROVIDER_AUDIT_KEY = "daily-command:ai-provider-audit:v1";
const AUDIT_MAX = 100;

export function kvProviderStore(kv: KvLike): ProviderStore {
  return {
    get: (id) => kv.get<AiProviderRecord>(AI_PROVIDER_KEY(id)),
    put: (id, rec) => kv.set(AI_PROVIDER_KEY(id), rec),
    del: (id) => kv.del(AI_PROVIDER_KEY(id)),
    async appendAudit(entry) {
      await kv.rpush(AI_PROVIDER_AUDIT_KEY, entry);
      await kv.ltrim(AI_PROVIDER_AUDIT_KEY, -AUDIT_MAX, -1);
    },
    listAudit: () => kv.lrange<AuditEntry>(AI_PROVIDER_AUDIT_KEY, 0, AUDIT_MAX - 1),
  };
}

/** null when no KV is available (production without KV): saving is impossible, env mode keeps working. */
export function providerStore(): ProviderStore | null {
  const kv = directoryKv();
  return kv ? kvProviderStore(kv) : null;
}

export const providerEnv = (): ProviderEnv => ({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST,
  ANTHROPIC_MODEL_DEEP: process.env.ANTHROPIC_MODEL_DEEP,
  AI_DAILY_TOKEN_CAP: process.env.AI_DAILY_TOKEN_CAP,
  AI_ALLOW_CUSTOM_BASE_URL: process.env.AI_ALLOW_CUSTOM_BASE_URL,
  AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  APP_STATE_SECRET: process.env.APP_STATE_SECRET,
});

export const sharedLimiter = new RateLimiter();

/** Anthropic clients are cached per key fingerprint for <= 60 s (a rotated key is picked up within a minute). */
const clients = new Map<string, { client: Anthropic; at: number }>();
export function anthropicClient(creds: Pick<ResolvedCredentials, "apiKey" | "fingerprint" | "baseUrl">, timeout = 55_000): Anthropic {
  const id = `${creds.fingerprint}|${creds.baseUrl ?? ""}|${timeout}`;
  const hit = clients.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.client;
  const client = new Anthropic({ apiKey: creds.apiKey, timeout, ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}) });
  clients.set(id, { client, at: Date.now() });
  if (clients.size > 20) clients.delete(clients.keys().next().value as string);
  return client;
}

/** The real SDK behind the test route. Errors keep their HTTP status so mapProviderError can name the cause. */
export const anthropicProviderSdk: ProviderSdk = {
  async listModels(apiKey, baseUrl) {
    const client = new Anthropic({ apiKey, timeout: 15_000, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) {
      ids.push(m.id);
      if (ids.length >= 500) break;
    }
    return ids;
  },
  async ping(apiKey, model, baseUrl) {
    const client = new Anthropic({ apiKey, timeout: 30_000, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    await client.messages.create({ model, max_tokens: 64, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
  },
};

/** The credentials a request runs with (member -> org -> global -> env), plus why a saved one was skipped. */
export async function credentialsFor(principal: ProviderPrincipal) {
  return resolveCredentials({ store: providerStore(), env: providerEnv(), scopes: scopesFor(principal.kind === "user" ? { kind: "user", uid: principal.uid } : { kind: "legacy" }) });
}

/** Wraps an SDK failure so the AI runner can log a plain errorKind + HTTP status, without ever leaking the key. */
export function toRunnerError(err: unknown): Error & { errorKind: string; status?: number } {
  const m = mapProviderError(err);
  const e = new Error(redactSecrets(`${m.message}`)) as Error & { errorKind: string; status?: number };
  e.errorKind = m.kind;
  if (m.httpStatus !== undefined) e.status = m.httpStatus;
  return e;
}
