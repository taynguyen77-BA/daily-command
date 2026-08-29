// Raw Jira REST API shapes (BUILD REQUEST V1.3 §6-7). These types describe exactly what
// Jira sends — nothing here is part of the app's own domain model (see ../types.ts).
// Every field is optional/nullable-tolerant because real Jira instances vary (custom
// workflows, missing assignee, missing fix version, deleted linked issues, etc.) — §29.
// Validated with zod so a malformed response degrades gracefully instead of crashing.

import { z } from "zod";

export const jiraUserSchema = z.object({
  accountId: z.string().optional(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
});

export const jiraStatusSchema = z.object({
  name: z.string(),
  statusCategory: z.object({ key: z.string().optional() }).optional(),
});

export const jiraPrioritySchema = z.object({ name: z.string().optional() });

export const jiraIssueTypeSchema = z.object({ name: z.string().optional() });

export const jiraFixVersionSchema = z.object({ name: z.string().optional(), releaseDate: z.string().optional() });

export const jiraIssueLinkSchema = z.object({
  type: z.object({ name: z.string().optional(), inward: z.string().optional(), outward: z.string().optional() }).optional(),
  inwardIssue: z
    .object({ key: z.string(), fields: z.object({ summary: z.string().optional(), status: jiraStatusSchema.optional() }).optional() })
    .optional(),
  outwardIssue: z
    .object({ key: z.string(), fields: z.object({ summary: z.string().optional(), status: jiraStatusSchema.optional() }).optional() })
    .optional(),
});

export const jiraIssueFieldsSchema = z.object({
  summary: z.string().optional(),
  status: jiraStatusSchema.optional(),
  priority: jiraPrioritySchema.nullable().optional(),
  assignee: jiraUserSchema.nullable().optional(),
  duedate: z.string().nullable().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  labels: z.array(z.string()).optional(),
  fixVersions: z.array(jiraFixVersionSchema).optional(),
  issuetype: jiraIssueTypeSchema.optional(),
  issuelinks: z.array(jiraIssueLinkSchema).optional(),
  project: z.object({ key: z.string().optional(), name: z.string().optional() }).optional(),
  flagged: z.boolean().optional(), // some instances expose a boolean "Flagged" custom field
});

export const jiraIssueSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  fields: jiraIssueFieldsSchema,
});
export type JiraIssue = z.infer<typeof jiraIssueSchema>;

// `issues` is deliberately required (not `.default([])`): an empty *array* is a valid
// "empty project" response, but a payload with no `issues` key at all (an error page, a
// totally different endpoint's JSON, etc.) must fail validation rather than silently
// looking like zero results — pagination relies on this to detect malformed pages (§29).
export const jiraSearchResponseSchema = z.object({
  issues: z.array(jiraIssueSchema),
  startAt: z.number().default(0),
  maxResults: z.number().default(50),
  total: z.number().default(0),
});
export type JiraSearchResponse = z.infer<typeof jiraSearchResponseSchema>;

// V2.2.2 — Atlassian has sunset the classic `GET /rest/api/3/search` endpoint on Jira Cloud
// (it now returns 410 Gone on every real Cloud site) in favor of `POST /rest/api/3/search/jql`,
// which is cursor/nextPageToken-based rather than startAt/total-based — there is no `total`
// to report, and `isLast`/absence of `nextPageToken` is how a caller knows it reached the
// last page. `issues` stays required for the same "malformed response must not look like an
// empty-but-valid page" reasoning as jiraSearchResponseSchema above.
export const jiraSearchJqlResponseSchema = z.object({
  issues: z.array(jiraIssueSchema),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});
export type JiraSearchJqlResponse = z.infer<typeof jiraSearchJqlResponseSchema>;

export const jiraProjectSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string().optional(),
});
export type JiraProject = z.infer<typeof jiraProjectSchema>;

// V1.7 §10 audit finding — `values` was previously `.default([])`, which meant a genuinely
// malformed response (wrong endpoint, an error page's JSON body, etc.) silently validated
// as "zero projects" instead of failing. Made required, matching jiraSearchResponseSchema's
// `issues` field above and its documented reasoning.
export const jiraProjectSearchResponseSchema = z.object({
  values: z.array(jiraProjectSchema),
  isLast: z.boolean().default(true),
  total: z.number().optional(),
});

export interface JiraConnectionConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

// V1.4 §32-33 — changelog shapes, fetched only for a small prioritized set of issues
// (never every issue — see jira/scope-drift.ts and the sync route).
export const jiraChangelogHistoryItemSchema = z.object({
  field: z.string().optional(),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
});

export const jiraChangelogHistorySchema = z.object({
  created: z.string().optional(),
  items: z.array(jiraChangelogHistoryItemSchema).default([]),
});
export type JiraChangelogHistory = z.infer<typeof jiraChangelogHistorySchema>;

export const jiraChangelogResponseSchema = z.object({
  values: z.array(jiraChangelogHistorySchema).default([]),
  startAt: z.number().default(0),
  maxResults: z.number().default(0),
  total: z.number().default(0),
});
export type JiraChangelogResponse = z.infer<typeof jiraChangelogResponseSchema>;
