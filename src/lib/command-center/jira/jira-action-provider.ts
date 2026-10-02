// Jira write-back. (BUILD REQUEST V1.3 §28 introduced this interface as a disabled extension
// point; V2.34 F4 adds the one real implementation behind it.)
//
// The app stays read-only by default: DisabledJiraActionProvider rejects every call, so even an
// accidental call fails loudly. HttpJiraActionProvider is used ONLY by the
// /api/command-center/jira/write route, which is called ONLY from the confirmation dialog of
// the opt-in write-back feature (off by default, per-project allow-list, a preview and an
// explicit confirm for every write — see jira/write-back.ts). assignIssue is not part of that
// feature and stays disabled in both.

import type { FetchLike } from "./http";
import type { JiraConnectionConfig } from "./types";

export interface JiraTransition {
  id: string;
  name: string;
  /** The status it leads to, when Jira says. */
  toStatus?: string;
}

export interface JiraActionProvider {
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  assignIssue(issueKey: string, accountId: string): Promise<void>;
  listTransitions(issueKey: string): Promise<JiraTransition[]>;
}

const NOT_ENABLED = "Future capability — not enabled. V1.3 does not write back to Jira; all actions remain human-in-the-loop.";

export class DisabledJiraActionProvider implements JiraActionProvider {
  async updateIssue(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
  async addComment(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
  async transitionIssue(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
  async assignIssue(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
  async listTransitions(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const WRITE_TIMEOUT_MS = 20_000;

/** Atlassian Document Format for a plain-text comment (one paragraph per line). */
export function adfFromText(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

/** The real provider (server-side only — it holds the Jira credentials). Every method throws
 *  an Error with Jira's message on a non-2xx answer, never fails silently. */
export class HttpJiraActionProvider implements JiraActionProvider {
  constructor(private readonly fetchImpl: FetchLike, private readonly config: JiraConnectionConfig) {}

  private async call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl).toString();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64"),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    let json: unknown = undefined;
    try {
      json = await res.json();
    } catch {
      // 204 No Content (PUT / transition) has no body
    }
    if (!res.ok) {
      const messages = (json as { errorMessages?: string[]; errors?: Record<string, string> } | undefined) ?? {};
      const detail = [...(messages.errorMessages ?? []), ...Object.values(messages.errors ?? {})].join("; ");
      throw new Error(`Jira answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return json;
  }

  private key(issueKey: string): string {
    if (!ISSUE_KEY.test(issueKey)) throw new Error(`Not a Jira issue key: ${issueKey}`);
    return encodeURIComponent(issueKey);
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.call("POST", `/rest/api/3/issue/${this.key(issueKey)}/comment`, { body: adfFromText(body) });
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("PUT", `/rest/api/3/issue/${this.key(issueKey)}`, { fields });
  }

  async listTransitions(issueKey: string): Promise<JiraTransition[]> {
    const json = (await this.call("GET", `/rest/api/3/issue/${this.key(issueKey)}/transitions`)) as { transitions?: { id?: unknown; name?: unknown; to?: { name?: unknown } }[] } | undefined;
    return (json?.transitions ?? [])
      .filter((t) => typeof t.id === "string" && typeof t.name === "string")
      .map((t) => ({ id: t.id as string, name: t.name as string, ...(typeof t.to?.name === "string" ? { toStatus: t.to.name } : {}) }));
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    if (!/^\d{1,9}$/.test(transitionId)) throw new Error(`Not a transition id: ${transitionId}`);
    await this.call("POST", `/rest/api/3/issue/${this.key(issueKey)}/transitions`, { transition: { id: transitionId } });
  }

  async assignIssue(): Promise<never> {
    throw new Error(NOT_ENABLED);
  }
}
