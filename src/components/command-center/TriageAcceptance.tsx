"use client";

// V2.37 I2 — how often Smart Triage suggestions were applied, per category, over the last 7
// days (local stats; nothing leaves this device). Shown on Weekly Review.

import { triageAcceptance, type TriageStatsByDay } from "@/lib/command-center/ai/smart-triage";
import { addDays } from "@/lib/command-center/date-utils";
import { Panel, SectionHeading } from "./ui";

export function TriageAcceptance({ stats, today }: { stats: TriageStatsByDay; today: string }) {
  const rows = triageAcceptance(stats, addDays(today, -6), today);
  if (rows.length === 0) return null;
  return (
    <Panel className="p-4" data-triage-acceptance>
      <SectionHeading title="Smart triage — acceptance this week" subtitle="Suggestions you applied vs. shown, per category. A low rate means the AI's suggestions in that category aren't helping." />
      <table className="text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.category} data-triage-category={r.category}>
              <td className="py-0.5 pr-4 text-text">{r.category}</td>
              <td className="py-0.5 pr-4 font-mono text-text2">
                {r.accepted}/{r.suggested}
              </td>
              <td className="py-0.5 font-mono text-text">{Math.round(r.rate * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
