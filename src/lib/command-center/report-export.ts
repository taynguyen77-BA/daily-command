// D7 — sending a report somewhere, always from an explicit click: Slack (through the existing
// notify route, which holds the webhook) or an email DRAFT (a mailto: link the user's mail app
// opens — nothing is sent from here). Pure helpers; the page owns the click + confirmation.

export const MAX_SLACK_REPORT_CHARS = 35000;
// mailto: bodies past ~2000 chars are truncated or rejected by several mail clients.
export const MAX_MAILTO_BODY_CHARS = 1800;

export function slackReportText(text: string): string {
  return text.length <= MAX_SLACK_REPORT_CHARS ? text : `${text.slice(0, MAX_SLACK_REPORT_CHARS - 40)}\n… (truncated — full report in the app)`;
}

export function emailDraftUrl(subject: string, body: string, to = ""): { url: string; truncated: boolean } {
  const truncated = body.length > MAX_MAILTO_BODY_CHARS;
  const text = truncated ? `${body.slice(0, MAX_MAILTO_BODY_CHARS)}\n… (truncated — paste the full report from "Copy plain text")` : body;
  return { url: `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, truncated };
}
