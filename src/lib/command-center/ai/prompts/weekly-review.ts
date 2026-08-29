import type { WeeklyReviewFacts } from "../../weekly-review";

export function weeklyReviewPrompt(facts: WeeklyReviewFacts): string {
  if (!facts.hasEnoughHistory) {
    return `You are writing a weekly review for an IT Business Analyst / Product Owner /
Project Manager, but fewer than 2 daily snapshots exist yet.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }
State plainly that there is insufficient historical data for a full weekly review yet, and
that "Close My Day" needs to run on at least two different days first. Do not fabricate any
of the sections below.`;
  }

  return `You are writing a weekly review for an IT Business Analyst / Product Owner /
Project Manager, covering the last ${facts.windowDays} day(s) of persisted snapshots.
Every fact below is deterministic — use ONLY these facts. Never invent an achievement,
a metric, or a decision that isn't listed.

DELIVERY CONFIDENCE: ${facts.currentConfidence}/100${facts.confidenceDelta !== null ? ` (change over window: ${facts.confidenceDelta > 0 ? "+" : ""}${facts.confidenceDelta})` : ""}

WHAT IMPROVED: ${facts.gettingBetter.length ? facts.gettingBetter.join("; ") : "nothing recorded"}
WHAT GOT WORSE: ${facts.gettingWorse.length ? facts.gettingWorse.join("; ") : "nothing recorded"}

RECURRING RISKS: ${facts.recurringRisks.length ? facts.recurringRisks.map((p) => p.title).join("; ") : "none detected"}

DECISIONS MADE IN WINDOW: ${facts.decisionsMade.length ? facts.decisionsMade.map((d) => d.title).join("; ") : "none"}
DECISIONS STILL UNRESOLVED: ${facts.decisionsUnresolved.length ? facts.decisionsUnresolved.map((d) => d.title).join("; ") : "none"}

ACTIONS COMPLETED: ${facts.actionsCompleted.length ? facts.actionsCompleted.map((a) => a.title).join("; ") : "none"}
ACTIONS THAT DID NOT RESOLVE THE ISSUE: ${facts.actionsThatDidNotResolveTheIssue.length ? facts.actionsThatDidNotResolveTheIssue.map((a) => a.title).join("; ") : "none"}

CARRY-OVER RISKS (still open since window start): ${facts.carryOverRisks.length ? facts.carryOverRisks.join("; ") : "none"}

NEXT WEEK'S CANDIDATE PRIORITIES (already ranked deterministically): ${
    facts.nextWeekPriorities.length ? facts.nextWeekPriorities.map((p) => `${p.item.key} — ${p.item.title}`).join("; ") : "none"
  }

CONSTRAINTS:
- Use only the facts given. If a section has no facts, say so plainly rather than inventing content.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string } formatted with these exact section
headers, each followed by 1-3 sentences or a short bullet list grounded only in the facts above:
## EXECUTIVE SUMMARY
## WHAT WENT WELL
## WHAT GOT WORSE
## RECURRING RISKS
## DECISIONS MADE
## DECISIONS STILL UNRESOLVED
## ACTIONS COMPLETED
## ACTIONS THAT DID NOT RESOLVE THE ISSUE
## CARRY-OVER RISKS
## NEXT WEEK'S PRIORITIES`;
}
