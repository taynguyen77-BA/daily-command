"use client";

// C1 — "Draft follow-up": the Needs From Others text (communicate.ts's
// renderNeedsFromOthersText, one message per recipient) behind a button on Dependencies,
// Waiting For and Blocked rows. Copy-only — nothing is ever sent from here.

import React, { useState } from "react";
import { renderNeedsFromOthersText, type NeedsFromOthersRow } from "@/lib/command-center/communicate";

export function FollowUpDraft({ rows, label = "Draft follow-up" }: { rows: NeedsFromOthersRow[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (rows.length === 0) return null;
  const text = renderNeedsFromOthersText(rows);
  return (
    <div className="mt-2" data-follow-up>
      <button
        onClick={() => {
          setOpen((v) => !v);
          setCopied(false);
        }}
        className="btn btn-sm btn-secondary"
      >
        {open ? "Hide follow-up" : label}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-surface2 p-2">
          <pre className="whitespace-pre-wrap text-xs text-text2">{text}</pre>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            }}
            className="mt-2 btn btn-sm btn-secondary"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
