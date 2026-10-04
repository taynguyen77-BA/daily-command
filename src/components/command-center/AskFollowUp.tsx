"use client";

// F2 — "Ask": the follow-up for a blocked ticket (or for every blocked ticket at once), one
// message per person (blocker-followup.ts groupAskByPerson over the Needs From Others rows).
// Each message can be copied, or sent to the server's Slack channel — but only after an
// explicit second click on an inline confirmation. Nothing is ever sent on its own.

import React, { useState } from "react";
import { groupAskByPerson } from "@/lib/command-center/blocker-followup";
import type { NeedsFromOthersRow } from "@/lib/command-center/communicate";
import { sendReportToSlack } from "@/lib/command-center/notify-client";
import { slackReportText } from "@/lib/command-center/report-export";
import { AiFollowUpDrafter } from "./AiFollowUpDrafter";

export type AskSend = (text: string) => Promise<{ sent: boolean; reason?: string; detail?: string }>;

const defaultSend: AskSend = (text) => sendReportToSlack(slackReportText(text));

/** Pure-ish view (state injectable) so the offline tests can render each stage. */
export function AskFollowUp({
  rows,
  label = "Ask",
  initialOpen = false,
  initialConfirming = null,
  send = defaultSend,
}: {
  rows: NeedsFromOthersRow[];
  label?: string;
  initialOpen?: boolean;
  /** Which person's Slack confirmation starts open (render tests). */
  initialConfirming?: string | null;
  send?: AskSend;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [confirming, setConfirming] = useState<string | null>(initialConfirming);
  const [status, setStatus] = useState<Record<string, string>>({});
  if (rows.length === 0) return null;
  const groups = groupAskByPerson(rows);

  async function doSend(person: string, text: string) {
    setConfirming(null);
    setStatus((s) => ({ ...s, [person]: "Sending…" }));
    const r = await send(text);
    setStatus((s) => ({ ...s, [person]: r.sent ? "Sent to Slack ✓" : r.reason === "not-configured" ? "Slack isn't configured (SLACK_WEBHOOK_URL)" : `Not sent${r.detail ? ` — ${r.detail}` : ""}` }));
  }

  return (
    <div className="mt-2" data-ask-follow-up>
      <button onClick={() => setOpen((v) => !v)} className="btn btn-sm btn-secondary" aria-expanded={open}>
        {open ? "Hide" : label}
        {!open && groups.length > 1 ? ` (${groups.length} people)` : ""}
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {groups.map((g) => (
            <li key={g.person} data-ask-person={g.person} className="rounded-md border border-border bg-surface2 p-2">
              <p className="text-xs font-medium text-text">To: {g.isUnknownPerson ? "who? (no owner recorded — pick the person before sending)" : g.person}</p>
              <pre className="mt-1 whitespace-pre-wrap text-xs text-text2">{g.text}</pre>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(g.text);
                    setStatus((s) => ({ ...s, [g.person]: "Copied ✓" }));
                  }}
                  className="btn btn-sm btn-secondary"
                >
                  Copy
                </button>
                {confirming === g.person ? (
                  <span className="flex items-center gap-1.5" data-ask-confirm>
                    <span className="text-xs text-text2">Send this message to the Slack channel configured on the server?</span>
                    <button onClick={() => void doSend(g.person, g.text)} className="btn btn-sm btn-primary">
                      Yes, send
                    </button>
                    <button onClick={() => setConfirming(null)} className="btn btn-sm btn-ghost">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirming(g.person)} className="btn btn-sm btn-ghost">
                    Send via Slack…
                  </button>
                )}
                {status[g.person] && <span className="text-xs text-text3">{status[g.person]}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {/* V2.38 J2 — the AI version, for the same blocked tickets (renders nothing when off). */}
      {open && <AiFollowUpDrafter ticketKeys={Array.from(new Set(rows.flatMap((r) => r.why.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [])))} />}
    </div>
  );
}
