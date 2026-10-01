"use client";

// D2 — the keyboard listener behind Daily Review's triage (J/K move, C complete, S skip,
// B block, R reviewed, O open in Jira). The mapping itself is triage-keys.ts (pure, tested);
// this only wires window keydown to it while the feature is on.

import { useEffect, useState } from "react";
import { triageCommand, type TriageCommand, type TriageRow } from "@/lib/command-center/triage-keys";

function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useTriageKeys(enabled: boolean, rows: TriageRow[], run: (cmd: TriageCommand) => void): number {
  const [selected, setSelected] = useState(0);
  const clamped = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const cmd = triageCommand(e.key, rows, clamped, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, inTextField: isTextField(e.target) });
      if (cmd.kind === "none") return;
      e.preventDefault();
      if (cmd.kind === "move") {
        setSelected(cmd.index);
        document.querySelector(`[data-triage-index="${cmd.index}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      run(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, rows, clamped, run]);
  return clamped;
}
