"use client";

// V2.38 J2 — AI version of "Ask": one message per person for their blocked tickets, in a Slack
// / Jira comment / email tone, with a suggested deadline. Copy; "Send via Slack…" with the same
// inline second confirmation as Ask; "Post on <KEY>…" through the write-back dialog; "Email
// draft" opens the mail app. Nothing is sent on its own.

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { buildFollowUpInput, type FollowUpChannel } from "@/lib/command-center/ai/blocker-followups-ai";
import type { FollowUpsResponse } from "@/lib/command-center/ai/schemas";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { emailDraftUrl, slackReportText } from "@/lib/command-center/report-export";
import { sendReportToSlack } from "@/lib/command-center/notify-client";
import { TrustLabel } from "./ui";

export function AiFollowUpDrafter({ ticketKeys }: { ticketKeys: string[] }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [channel, setChannel] = useState<FollowUpChannel>("slack");
  const [drafts, setDrafts] = useState<{ messages: FollowUpsResponse["messages"]; ticketsByPerson: Record<string, string[]>; mode: "mock" | "claude" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  if (!state.features.aiBlockerFollowUp || ticketKeys.length === 0) return null;

  const draft = async (ch: FollowUpChannel) => {
    setBusy(true);
    setStatus({});
    const s = commandCenterStore.getSnapshot();
    const built = buildFollowUpInput({ states: s.ticketWorkStates, data: s.data, mentionEvents: s.mentionEvents, settings: s.aiDataProtection, slaBusinessDays: s.blockerSlaBusinessDays, today: todayLocalIso(), channel: ch, ticketKeys });
    if (!built) {
      setBusy(false);
      return setDrafts({ messages: [], ticketsByPerson: {}, mode: "mock" });
    }
    const provider = getAIProvider();
    const out = built.session.restoreDeep(await provider.draftBlockerFollowUps(built.input));
    setDrafts({ messages: out.messages, ticketsByPerson: { ...built.ticketsByPerson, team: built.ticketsByPerson.Unknown ?? [] }, mode: provider.mode });
    setBusy(false);
  };

  const note = (person: string, text: string) => setStatus((x) => ({ ...x, [person]: text }));

  return (
    <div data-ai-follow-up className="mt-2 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-draft" />
        <label className="flex items-center gap-1">
          Tone
          <select value={channel} onChange={(e) => { setChannel(e.target.value as FollowUpChannel); setDrafts(null); }} aria-label="Follow-up tone" className="rounded border border-border bg-surface px-1 py-0.5">
            <option value="slack">Slack</option>
            <option value="jira">Jira comment</option>
            <option value="email">Email</option>
          </select>
        </label>
        <button onClick={() => void draft(channel)} disabled={busy} className="btn btn-sm btn-secondary">
          {busy ? "Drafting…" : drafts ? "Redraft" : "Draft with AI"}
        </button>
        {drafts && <span className="text-text3">{drafts.mode === "claude" ? "AI drafts — edit before sending." : "Template drafts (AI not used)."}</span>}
      </div>
      {drafts && drafts.messages.length === 0 && <p className="mt-1 text-text3">No blocked tickets to follow up on.</p>}
      {drafts && (
        <ul className="mt-2 space-y-2">
          {drafts.messages.map((m) => {
            const keys = drafts.ticketsByPerson[m.person] ?? [];
            return (
              <li key={m.person} data-ai-follow-up-person={m.person} className="rounded border border-border bg-surface p-2">
                <p className="font-medium text-text">
                  To: {m.person}
                  {m.suggestedDeadline && <span className="ml-2 text-text3">answer by {m.suggestedDeadline}</span>}
                </p>
                {m.subject && <p className="text-text3">Subject: {m.subject}</p>}
                <pre className="mt-1 whitespace-pre-wrap">{m.text}</pre>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <button onClick={async () => { await navigator.clipboard.writeText(m.subject ? `${m.subject}\n\n${m.text}` : m.text); note(m.person, "Copied ✓"); }} className="btn btn-sm btn-secondary">
                    Copy
                  </button>
                  {channel === "slack" &&
                    (confirming === m.person ? (
                      <span className="flex items-center gap-1.5" data-ai-follow-up-confirm>
                        Send to the Slack channel configured on the server?
                        <button
                          onClick={async () => {
                            setConfirming(null);
                            note(m.person, "Sending…");
                            const r = await sendReportToSlack(slackReportText(m.text));
                            note(m.person, r.sent ? "Sent to Slack ✓" : r.reason === "not-configured" ? "Slack isn't configured" : "Not sent");
                          }}
                          className="btn btn-sm btn-primary"
                        >
                          Yes, send
                        </button>
                        <button onClick={() => setConfirming(null)} className="btn btn-sm btn-ghost">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirming(m.person)} className="btn btn-sm btn-ghost">
                        Send via Slack…
                      </button>
                    ))}
                  {channel === "jira" &&
                    keys.map((k) => (
                      <button key={k} onClick={() => note(m.person, commandCenterStore.proposeJiraComment(k, m.text) ? `Review it in the dialog for ${k}.` : `Jira write-back isn't on for ${k}'s project — copy instead.`)} className="btn btn-sm btn-ghost">
                        Post on {k}…
                      </button>
                    ))}
                  {channel === "email" && (
                    <a href={emailDraftUrl(m.subject ?? "Follow-up", m.text).url} className="btn btn-sm btn-ghost" title="Opens a draft in your mail app — nothing is sent from here">
                      Email draft
                    </a>
                  )}
                  {status[m.person] && <span className="text-text3">{status[m.person]}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
