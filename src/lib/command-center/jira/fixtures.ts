// V1.7 §5 — sanitized fixture Jira API responses for the conformance harness. No real
// credentials, tokens, or PII ever appear here — every name/email below is fabricated.
// These fixtures let the harness (and its regression tests) run identically whether or not
// a real Jira sandbox is available, using the same dependency-injected FetchLike the real
// client uses (jira/http.ts) — nothing here bypasses the real parsing/validation code.

import type { FetchLike } from "./http";

export function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

export const FIXTURE_PROJECT_SEARCH = {
  values: [
    { id: "10001", key: "JPMC", name: "JPMC Digital Onboarding" },
    { id: "10002", key: "WF", name: "WF Payments Rollout" },
  ],
  isLast: true,
  total: 2,
};

function fixtureIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "20001",
    key: "JPMC-101",
    fields: {
      summary: "Release readiness sign-off",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { name: "High" },
      assignee: { accountId: "acc-1", displayName: "Fixture Owner", emailAddress: "owner@example.test" },
      duedate: "2026-09-01",
      created: "2026-08-01T09:00:00.000Z",
      updated: "2026-08-20T14:32:00.000Z",
      labels: ["release"],
      fixVersions: [{ name: "2026.09" }],
      issuetype: { name: "Story" },
      issuelinks: [
        {
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: { key: "JPMC-050", fields: { summary: "Sandbox credentials", status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } },
        },
      ],
      project: { key: "JPMC", name: "JPMC Digital Onboarding" },
      flagged: false,
      ...overrides,
    },
  };
}

export const FIXTURE_ISSUE_PAGE_1 = { issues: [fixtureIssue(), fixtureIssue({ summary: "UAT defect triage" })], startAt: 0, maxResults: 2, total: 3 };
export const FIXTURE_ISSUE_PAGE_2 = { issues: [fixtureIssue({ summary: "Payment gateway integration" })], startAt: 2, maxResults: 2, total: 3 };

export const FIXTURE_ISSUE_MALFORMED_MISSING_FIELDS = { issues: [{ key: "JPMC-999", fields: {} }], startAt: 0, maxResults: 50, total: 1 };
export const FIXTURE_ISSUE_UNKNOWN_STATUS = fixtureIssue({ status: { name: "Custom Vendor Status", statusCategory: { key: "some-custom-category" } } });
export const FIXTURE_ISSUE_DELETED_LINK = fixtureIssue({ issuelinks: [{ type: { name: "Blocks" } }] }); // linked issue itself deleted — no inwardIssue

export const FIXTURE_CHANGELOG = {
  values: [
    { created: "2026-08-15T10:00:00.000Z", items: [{ field: "priority", fromString: "Medium", toString: "High" }] },
    { created: "2026-08-18T11:00:00.000Z", items: [{ field: "status", fromString: "In Progress", toString: "Blocked" }] },
    { created: "2026-08-19T12:00:00.000Z", items: [{ field: "comment", fromString: null, toString: "not a scope field, ignored" }] },
  ],
  startAt: 0,
  maxResults: 100,
  total: 3,
};

/** A fetch double that serves fixtures deterministically by URL shape, matching the real
 *  Atlassian REST endpoints exactly — the harness exercises the same URL-building code the
 *  real client uses. */
export function fixtureFetch(overrides?: Partial<{ issuePages: unknown[]; malformed: boolean; httpStatus: number; capabilityStatus: number }>): FetchLike {
  let issueCallCount = 0;
  const pages = overrides?.issuePages ?? [FIXTURE_ISSUE_PAGE_1, FIXTURE_ISSUE_PAGE_2];
  return async (url: string) => {
    // V1.8 §5 — the cursor-capability probe is checked before the generic httpStatus
    // override so capability tests can run independently of the other error-path fixtures.
    // Fixtures model a classic (Server/DC-shaped) instance by default: no cursor endpoint.
    if (url.includes("/search/jql")) {
      return jsonResponse(overrides?.capabilityStatus ?? 404, overrides?.capabilityStatus && overrides.capabilityStatus < 300 ? { issues: [], isLast: true, nextPageToken: undefined } : { errorMessages: ["fixture: no enhanced JQL search endpoint"] });
    }
    if (overrides?.httpStatus && overrides.httpStatus !== 200) {
      return jsonResponse(overrides.httpStatus, { errorMessages: ["fixture error"] });
    }
    if (url.includes("/project/search")) return jsonResponse(200, overrides?.malformed ? { not: "the expected shape" } : FIXTURE_PROJECT_SEARCH);
    if (url.includes("/changelog")) return jsonResponse(200, overrides?.malformed ? { not: "the expected shape" } : FIXTURE_CHANGELOG);
    if (url.includes("/search")) {
      const page = pages[issueCallCount] ?? { issues: [], startAt: issueCallCount, maxResults: 50, total: pages.length };
      issueCallCount += 1;
      return jsonResponse(200, overrides?.malformed ? { not: "the expected shape" } : page);
    }
    return jsonResponse(404, { errorMessages: ["unknown fixture endpoint"] });
  };
}
