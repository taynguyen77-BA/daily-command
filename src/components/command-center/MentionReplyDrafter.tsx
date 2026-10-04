"use client";

// V2.37 I3 — "Draft reply" on a mention row. Uses the ticket's comment thread (allow-listed +
// redacted), with tone / language / length options; every option set is its own draft. The
// draft is editable and is only ever copied, or handed to the existing Jira write-back dialog
// ("Post to Jira…": preview + confirm + server gate). Posting marks the mention replied.

import { useRef, useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { loadIssueContext } from "@/lib/command-center/ai/ticket-ai-client";
import { DEFAULT_REPLY_OPTIONS, draftMentionReplyFlow, memoryDraftCache, MENTION_NOT_FOUND_NOTICE, type MentionRef, type ReplyOptions } from "@/lib/command-center/ai/mention-reply";
import { projectKeyOf } from "@/lib/command-center/ai/data-protection";
import type { MentionReplyResponse } from "@/lib/command-center/ai/schemas";
import { TrustLabel } from "./ui";

const draftCache = memoryDraftCache();

type Phase = { kind: "closed" } | { kind: "options" } | { kind: "loading" } | { kind: "preview"; preview: string } | { kind: "draft"; draft: MentionReplyResponse; mode: "mock" | "claude"; excerptOnly: boolean } | { kind: "message"; text: string };

export function MentionReplyDrafter({ mention }: { mention: MentionRef }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [opts, setOpts] = useState<ReplyOptions>(DEFAULT_REPLY_OPTIONS);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const runId = useRef(0);
  if (!state.features.mentionReplyDrafter) return null;

  const draft = async (options: ReplyOptions, previewConfirmed = false) => {
    const id = ++runId.current;
    setPhase({ kind: "loading" });
    setStatus(null);
    if (previewConfirmed) commandCenterStore.acknowledgeAiSendPreview(projectKeyOf(mention.issueKey));
    const provider = getAIProvider();
    const r = await draftMentionReplyFlow({
      // K1 — a cached thread older than the mention (or without it) is refetched by the flow.
      loadContext: (force) => loadIssueContext(commandCenterStore, mention.issueKey, { force }),
      mention,
      options,
      settings: commandCenterStore.getSnapshot().aiDataProtection,
      provider,
      cache: draftCache,
      previewConfirmed,
    });
    if (id !== runId.current) return;
    if (r.kind === "error") setPhase({ kind: "message", text: r.message });
    else if (r.kind === "disabled") setPhase({ kind: "message", text: `${r.reason} — allow it in Data & Settings → AI data protection.` });
    else if (r.kind === "needs-preview") setPhase({ kind: "preview", preview: r.preview });
    else {
      setText(r.draft.reply);
      setPhase({ kind: "draft", draft: r.draft, mode: r.mode, excerptOnly: r.excerptOnly });
    }
  };

  const change = (patch: Partial<ReplyOptions>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    // A different tone / language / length is a different draft.
    if (phase.kind === "draft") void draft(next);
  };

  if (phase.kind === "closed") {
    return (
      <button onClick={() => setPhase({ kind: "options" })} data-draft-reply-open={mention.commentId} className="btn btn-sm btn-secondary">
        Draft reply
      </button>
    );
  }

  const select = <K extends keyof ReplyOptions>(key: K, label: string, choices: [ReplyOptions[K], string][]) => (
    <label className="flex items-center gap-1">
      <span className="text-text3">{label}</span>
      <select value={opts[key]} onChange={(e) => change({ [key]: e.target.value } as Partial<ReplyOptions>)} aria-label={label} className="rounded border border-border bg-surface px-1 py-0.5">
        {choices.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div data-reply-drafter={mention.commentId} className="mt-2 w-full rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-draft" />
        {select("tone", "Tone", [["internal", "Internal"], ["client", "Client-facing"]])}
        {select("language", "Language", [["en", "EN"], ["vi", "VI"]])}
        {select("length", "Length", [["normal", "Normal"], ["short", "Short"]])}
        {(phase.kind === "options" || phase.kind === "message") && (
          <button onClick={() => void draft(opts)} className="btn btn-sm btn-primary">
            Draft
          </button>
        )}
        <button onClick={() => setPhase({ kind: "closed" })} className="ml-auto text-text3 hover:text-text" aria-label="Close drafter">
          ✕
        </button>
      </div>
      {phase.kind === "loading" && <p className="mt-1">Drafting…</p>}
      {phase.kind === "message" && <p className="mt-1 text-orange">{phase.text}</p>}
      {phase.kind === "preview" && (
        <div className="mt-1">
          <p className="text-text">First AI use for this project — this is exactly what will be sent. Nothing has been sent yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-accent2">What will be sent</summary>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[11px]">{phase.preview}</pre>
          </details>
          <button onClick={() => void draft(opts, true)} className="btn btn-sm btn-primary mt-1">
            Send
          </button>
        </div>
      )}
      {phase.kind === "draft" && (
        <div className="mt-1">
          <p className="text-text3">{phase.mode === "claude" ? "AI draft — edit before using it." : "AI unavailable — a template draft to edit."}</p>
          {phase.excerptOnly && (
            <p data-reply-excerpt-only className="mt-1 text-orange">
              {MENTION_NOT_FOUND_NOTICE}
            </p>
          )}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} aria-label="Reply draft" className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm" />
          {phase.draft.unansweredPoints.length > 0 && (
            <div className="mt-1">
              <p className="font-semibold text-text3">Not answered in this draft</p>
              <ul className="list-disc pl-4">
                {phase.draft.unansweredPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setStatus("Copied.");
                } catch {
                  setStatus("Couldn't copy — select the text instead.");
                }
              }}
              className="btn btn-sm btn-secondary"
            >
              Copy
            </button>
            <button
              onClick={() => setStatus(commandCenterStore.proposeJiraReply(mention.issueKey, text, mention.commentId) ? "Review it in the dialog — nothing is posted until you confirm." : "Jira write-back isn't on for this project (Features + allow-list) — copy it instead.")}
              className="btn btn-sm btn-secondary"
            >
              Post to Jira…
            </button>
            {status && <span className="text-text3">{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
