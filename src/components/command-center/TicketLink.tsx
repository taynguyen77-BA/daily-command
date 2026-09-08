import React from "react";

/** V2.13 §3 — one shared component for every place a Jira ticket key is shown. `sourceUrl`
 *  is already populated at normalization time (jira/normalize.ts's `issueUrl` helper) for
 *  real Jira data; Demo mode and Local Import never have a real Jira URL, so `url` is
 *  `undefined` for them — this component follows the same "never fabricate a link from a key
 *  pattern" discipline `issueUrl` itself follows, and always falls back to plain text rather
 *  than a broken or invented href. */
export function TicketLink({ ticketKey, url, className = "" }: { ticketKey: string; url?: string; className?: string }) {
  if (!url) return <span className={className}>{ticketKey}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-0.5 hover:underline ${className}`}
    >
      {ticketKey}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="shrink-0">
        <path d="M3 1.5H8.5V7M8.5 1.5L1.5 8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
