// H1 — one ticket's CONTENT, on demand (never part of the bulk sync): summary, description,
// the acceptance-criteria custom field when one is configured, the last 20 comments, linked
// issues and the last 10 status transitions. Pure + fetch-injected like ./http.ts, so it is
// tested offline with fixtures; the only caller with real credentials is
// app/api/command-center/jira/issue-context/route.ts (via server/jira-client.ts).
//
// What comes back here goes to the BROWSER only. Whether any of it ever reaches the model is
// decided client-side by the per-project AI allow-list + redaction (ai/data-protection.ts).

import { z } from "zod";
import { authHeader, buildUrl, describeJiraError, fetchIssueChangelogWith, isValidCustomFieldId, JIRA_FETCH_TIMEOUT_MS, type FetchLike, type JiraFetchResult } from "./http";
import { jiraCommentPageResponseSchema, jiraIssueLinkSchema, jiraStatusSchema, jiraUserSchema, type JiraConnectionConfig } from "./types";

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
export const ISSUE_CONTEXT_MAX_COMMENTS = 20;
export const ISSUE_CONTEXT_MAX_TRANSITIONS = 10;
const MAX_TEXT = 20_000;
const MAX_COMMENT_TEXT = 4_000;

export interface IssueContextComment {
  author: string;
  created: string;
  body: string;
}
export interface IssueContextLink {
  key: string;
  summary: string;
  status: string;
  relation: string;
}
export interface IssueContextTransition {
  at: string;
  from: string;
  to: string;
  author?: string;
}
export interface IssueContext {
  key: string;
  projectKey: string;
  summary: string;
  status: string;
  /** Jira's own `updated` — the cache key (a changed ticket is refetched). */
  updated: string;
  description: string;
  acceptanceCriteria?: string;
  comments: IssueContextComment[];
  links: IssueContextLink[];
  statusHistory: IssueContextTransition[];
  /** Status history could not be read (permissions, error) — the rest is still valid. */
  statusHistoryUnavailable?: boolean;
  fetchedAt: string;
}

// ===== ADF → plain text / light markdown ===============================================

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type AdfNode = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown; marks?: unknown };

function inline(nodes: unknown): string {
  if (!Array.isArray(nodes)) return "";
  return nodes.map((n) => node(n as AdfNode, 0)).join("");
}

function node(n: AdfNode, depth: number): string {
  if (!n || typeof n !== "object") return "";
  const attrs = n.attrs ?? {};
  switch (n.type) {
    case "text": {
      const text = typeof n.text === "string" ? n.text : "";
      const link = Array.isArray(n.marks) ? (n.marks as AdfNode[]).find((m) => m?.type === "link") : undefined;
      const href = typeof link?.attrs?.href === "string" ? link.attrs.href : undefined;
      return href && href !== text ? `${text} (${href})` : text;
    }
    case "hardBreak":
      return "\n";
    case "mention":
      return typeof attrs.text === "string" ? (attrs.text.startsWith("@") ? attrs.text : `@${attrs.text}`) : "@someone";
    case "emoji":
      return typeof attrs.text === "string" ? attrs.text : typeof attrs.shortName === "string" ? attrs.shortName : "";
    case "inlineCard":
    case "blockCard":
      return typeof attrs.url === "string" ? attrs.url : "";
    case "status":
    case "date":
      return typeof attrs.text === "string" ? attrs.text : typeof attrs.timestamp === "string" ? new Date(Number(attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "paragraph":
      return inline(n.content);
    case "heading": {
      const level = typeof attrs.level === "number" ? Math.min(Math.max(attrs.level, 1), 6) : 2;
      return `${"#".repeat(level)} ${inline(n.content)}`;
    }
    case "bulletList":
    case "orderedList": {
      const items = Array.isArray(n.content) ? (n.content as AdfNode[]) : [];
      return items
        .map((item, i) => {
          const body = blocks(item.content, depth + 1).replace(/\n/g, `\n${"  ".repeat(depth + 1)}`);
          return `${"  ".repeat(depth)}${n.type === "orderedList" ? `${i + 1}.` : "-"} ${body}`;
        })
        .join("\n");
    }
    case "codeBlock":
      return "```\n" + inline(n.content) + "\n```";
    case "blockquote":
      return blocks(n.content, depth)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return (Array.isArray(n.content) ? (n.content as AdfNode[]) : [])
        .map((row) => "| " + (Array.isArray(row.content) ? (row.content as AdfNode[]) : []).map((cell) => blocks(cell.content, depth).replace(/\n/g, " ")).join(" | ") + " |")
        .join("\n");
    case "panel":
    case "expand":
    case "nestedExpand":
    case "doc":
    case "listItem":
    case "tableRow":
    case "tableCell":
    case "tableHeader":
    case "mediaSingle":
    case "mediaGroup":
      return blocks(n.content, depth);
    case "media":
      return "[attachment]";
    default:
      return Array.isArray(n.content) ? blocks(n.content, depth) : typeof n.text === "string" ? n.text : "";
  }
}

function blocks(nodes: unknown, depth: number): string {
  if (!Array.isArray(nodes)) return "";
  return nodes
    .map((c) => node(c as AdfNode, depth))
    .filter((s) => s.trim() !== "")
    .join("\n\n");
}

/** ADF (or a plain string, or null) → readable text with light markdown. Never throws. */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  try {
    return node(value as AdfNode, 0).replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

/** A custom field's value as text: ADF, a string, an option ({value}) or a list of them. */
export function customFieldToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(customFieldToText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.type === "doc") return adfToText(v);
    if (typeof v.value === "string") return v.value;
    if (typeof v.name === "string") return v.name;
  }
  return "";
}

// ===== Fetch =========================================================================

const issueResponseSchema = z.object({
  key: z.string(),
  fields: z
    .object({
      summary: z.string().optional(),
      description: z.unknown().optional(),
      status: jiraStatusSchema.optional(),
      updated: z.string().optional(),
      project: z.object({ key: z.string().optional() }).optional(),
      issuelinks: z.array(jiraIssueLinkSchema).optional(),
    })
    .catchall(z.unknown()),
});

const commentAuthorName = (author: z.infer<typeof jiraUserSchema> | null | undefined) => author?.displayName?.trim() || "Unknown";

export async function fetchIssueContextWith(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  issueKey: string,
  options: { acceptanceCriteriaFieldId?: string; nowIso?: string } = {}
): Promise<JiraFetchResult<IssueContext>> {
  if (!ISSUE_KEY_RE.test(issueKey)) return { ok: false, error: "Not a valid Jira issue key.", errorKind: "unknown" };
  const acField = isValidCustomFieldId(options.acceptanceCriteriaFieldId) ? options.acceptanceCriteriaFieldId : undefined;
  const fields = ["summary", "description", "status", "updated", "project", "issuelinks", ...(acField ? [acField] : [])].join(",");
  const headers = { Authorization: authHeader(config), Accept: "application/json" };
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  try {
    const [issueRes, commentRes, changelog] = await Promise.all([
      fetchImpl(buildUrl(config.baseUrl, path, { fields }), { headers, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) }),
      fetchImpl(buildUrl(config.baseUrl, `${path}/comment`, { orderBy: "-created", maxResults: String(ISSUE_CONTEXT_MAX_COMMENTS) }), { headers, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) }),
      fetchIssueChangelogWith(fetchImpl, config, issueKey),
    ]);
    if (!issueRes.ok) return { ok: false, ...(await describeJiraError(issueRes)) };
    let issueJson: unknown;
    try {
      issueJson = await issueRes.json();
    } catch {
      return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
    }
    const issue = issueResponseSchema.safeParse(issueJson);
    if (!issue.success) return { ok: false, error: "Jira's issue response did not match the expected shape.", errorKind: "malformed-response" };
    const f = issue.data.fields;

    // Comments are best-effort: a comment-permission failure still returns the ticket itself.
    let comments: IssueContextComment[] = [];
    if (commentRes.ok) {
      try {
        const parsed = jiraCommentPageResponseSchema.safeParse(await commentRes.json());
        if (parsed.success) {
          comments = parsed.data.comments
            .slice(0, ISSUE_CONTEXT_MAX_COMMENTS)
            .map((c) => ({ author: commentAuthorName(c.author), created: c.created ?? "", body: clip(adfToText(c.body), MAX_COMMENT_TEXT) }))
            // oldest first, so the thread reads in order
            .sort((a, b) => a.created.localeCompare(b.created));
        }
      } catch {
        comments = [];
      }
    }

    const links: IssueContextLink[] = (f.issuelinks ?? []).flatMap((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      if (!other) return [];
      const relation = (l.outwardIssue ? l.type?.outward : l.type?.inward) ?? l.type?.name ?? "relates to";
      return [{ key: other.key, summary: other.fields?.summary ?? "", status: other.fields?.status?.name ?? "", relation }];
    });

    const statusHistory: IssueContextTransition[] = changelog.ok
      ? changelog.data
          .flatMap((h) =>
            h.items
              .filter((i) => i.field === "status")
              .map((i) => ({ at: h.created ?? "", from: i.fromString ?? "", to: i.toString ?? "", ...(h.author?.displayName ? { author: h.author.displayName } : {}) }))
          )
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(-ISSUE_CONTEXT_MAX_TRANSITIONS)
      : [];

    const acceptanceCriteria = acField ? clip(customFieldToText(f[acField]), MAX_TEXT) : undefined;
    const context: IssueContext = {
      key: issue.data.key,
      projectKey: f.project?.key ?? issue.data.key.split("-")[0],
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      updated: f.updated ?? "",
      description: clip(adfToText(f.description), MAX_TEXT),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      comments,
      links,
      statusHistory,
      ...(changelog.ok ? {} : { statusHistoryUnavailable: true }),
      fetchedAt: options.nowIso ?? new Date().toISOString(),
    };
    return { ok: true, data: context, recordsFetched: 1 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}
