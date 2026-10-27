// P3.2 — the My Work "whose turn" filter. Pure; reads the same ConversationState the chip does.

import type { ConversationState } from "./conversation-state";

export type ConversationFilter = "all" | "awaiting-me" | "awaiting-them";

export function rowMatchesConversationFilter(filter: ConversationFilter, c: ConversationState | undefined): boolean {
  if (filter === "all") return true;
  return filter === "awaiting-me" ? c?.awaiting === "ME" : c?.awaiting === "THEM";
}
