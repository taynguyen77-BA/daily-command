// Future capability — not enabled. (BUILD REQUEST V1.3 §28)
//
// This interface exists ONLY to prevent an architectural rework later, when Jira
// write-back is actually built. No method here is ever called anywhere in V1.3 — every
// implementation immediately rejects, so even an accidental call fails loudly instead of
// silently doing nothing (or worse, something).

export interface JiraActionProvider {
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<never>;
  addComment(issueKey: string, body: string): Promise<never>;
  transitionIssue(issueKey: string, transitionId: string): Promise<never>;
  assignIssue(issueKey: string, accountId: string): Promise<never>;
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
}
