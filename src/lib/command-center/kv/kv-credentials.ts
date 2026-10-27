// P2.4 — which Redis/KV credentials this deployment has. Pure (env in, answer out): no SDK.
// Vercel's KV integration injects KV_REST_API_URL / KV_REST_API_TOKEN; a Redis (Upstash) integration
// injects UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. The first COMPLETE pair wins (KV_* first,
// so existing deployments keep exactly the store they already use); a half-set pair is ignored.

export interface KvCredentials {
  url: string;
  token: string;
  source: "KV_REST_API" | "UPSTASH_REDIS_REST";
}

export function resolveKvCredentials(env: Record<string, string | undefined> = process.env): KvCredentials | null {
  const pairs: [string, string, KvCredentials["source"]][] = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_REST_API"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST"],
  ];
  for (const [u, t, source] of pairs) {
    const url = env[u]?.trim();
    const token = env[t]?.trim();
    if (url && token) return { url, token, source };
  }
  return null;
}

export function isKvConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return resolveKvCredentials(env) !== null;
}
