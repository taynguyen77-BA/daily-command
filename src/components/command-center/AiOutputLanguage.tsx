"use client";

// V2.51 A3 — the language of AI weekly insights, weekly review, end-of-day summary and ticket brief (English by default).
// Ticket keys, product names and code identifiers are never translated; calculated text is unaffected.

import { useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";

export function AiOutputLanguage() {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const lang = state.aiOutputLanguage === "vi" ? "vi" : "en";
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-text2" data-ai-output-language>
      AI answer language
      <select value={lang} onChange={(e) => commandCenterStore.setAiOutputLanguage(e.target.value === "vi" ? "vi" : "en")} className="rounded border border-border bg-surface px-1.5 py-1 text-xs">
        <option value="en">English</option>
        <option value="vi">Tiếng Việt</option>
      </select>
      <span className="text-xs text-text3">Weekly insights, weekly review, end-of-day summary and ticket brief. Ticket keys and product names stay as written.</span>
    </label>
  );
}
