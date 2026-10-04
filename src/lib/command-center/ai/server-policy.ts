// K4 — the server's own AI data policy. AI_ALLOWED_PROJECT_KEYS (comma list) names the only
// projects whose ticket CONTENT the server will hand out for AI use
// (GET /api/command-center/jira/issue-context); any other project is a 403 before Jira is
// called. The browser's per-project allow-list (data-protection.ts) still applies on top, so
// the effective set is the intersection. Unset = no server restriction (the client list alone).

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;

export const AI_SERVER_POLICY_DENIED = "This project is outside the server's AI_ALLOWED_PROJECT_KEYS — its ticket content isn't available for AI.";

/** null when unset/blank (no server restriction); otherwise the valid, upper-cased keys —
 *  possibly empty, which allows nothing (a set-but-garbled value never means "everything"). */
export function parseAiAllowedProjectKeys(raw: string | undefined): string[] | null {
  if (!raw || raw.trim() === "") return null;
  const keys = raw
    .split(",")
    .map((k) => k.trim().toUpperCase())
    .filter((k) => PROJECT_KEY_RE.test(k));
  return Array.from(new Set(keys));
}

export function aiServerPolicyAllows(projectKey: string, allowed: string[] | null): boolean {
  return allowed === null || allowed.includes(projectKey.toUpperCase());
}
