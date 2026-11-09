// V2.50 R1 — the Report Narrative: what an IT Business Analyst says at a standup or records in a work log, from the report's facts.
// Everything the model may use is below; numbers and ticket keys are locked to it (grounding guard + narrativeViolations).

import type { TaskInput } from "../task-registry";

const line = (i: { key: string; title?: string; project?: string }) => `- ${i.key}${i.title ? ` — ${i.title}` : ""}${i.project ? ` (${i.project})` : ""}`;
const list = (title: string, rows: string[]) => `${title}\n${rows.length ? rows.join("\n") : "- (none)"}`;

export function reportNarrativePrompt(i: TaskInput<"summarizeReport">): string {
  const c = i.counts;
  const lang = i.language === "vi" ? "Vietnamese (tiếng Việt; keep ticket keys, product names and English technical terms as written)" : "English";
  const counts = [
    `done=${c.done}`, `in-progress=${c.inProgress}`, `blocked=${c.blocked}`, `new=${c.newReceived}`, `mentions-awaiting-reply=${c.mentionsAwaitingReply}`,
    `blockers-over-SLA=${c.overdueBlockers}`, `decisions=${c.decisions}`, `projects=${c.projects}`, `done-not-listed=${c.doneNotListed}`,
    ...(c.carriedOver !== undefined ? [`carried-over=${c.carriedOver}`] : []),
    ...(c.nextWeek !== undefined ? [`next-week=${c.nextWeek}`] : []),
    ...(c.reportedDays !== undefined ? [`reported-days=${c.reportedDays}`] : []),
    ...(c.missingDays !== undefined ? [`days-without-report=${c.missingDays}`] : []),
    ...(c.slaBusinessDays !== undefined ? [`SLA-business-days=${c.slaBusinessDays}`] : []),
  ].join(" ");
  const blocked = i.blocked.map((b) => `${line(b)}${b.ageBusinessDays !== undefined ? ` — ${b.ageBusinessDays} business days` : ""}${b.waitingFor ? ` — waiting for ${b.waitingFor}` : ""}${b.reason ? ` — reason: ${b.reason}` : ""}`);
  return `You write what an IT Business Analyst says at a daily standup or records in a work log, from the facts below.
Write in ${lang}.
Output: ONE paragraph of EXACTLY 3 to 5 sentences. Plain text. No bullets, no markdown, no emoji, no headings.
Refer to the period as: "${i.periodPhrase}" (copy it exactly).

COUNTS (the only numbers you may use besides numbers inside the lists):
${counts}

${list("DONE:", i.done.map(line))}
${list("IN PROGRESS:", i.inProgress.map(line))}
${list("BLOCKED (oldest first):", blocked)}
${i.nextWeek ? `${list("NEXT WEEK:", i.nextWeek.map(line))}\n` : ""}${list("DECISIONS:", i.decisions.map((d) => `- ${d}`))}
${i.risk ? `BIGGEST RISK: ${i.risk.title}${i.risk.level ? ` (${i.risk.level})` : ""}\n` : ""}
STYLE standup: first person. Order: what I finished → what I am working on → what is blocked, since when and on whom → what needs attention (mentions awaiting reply, blockers over SLA, decisions).
STYLE worklog: neutral past tense for a timesheet or work log. What was completed (group by project, name up to 3 key tickets), what was progressed, one clause on anything blocked. No requests, no plans.
STYLE to use now: ${i.style}.
RULES:
- Mention at most 6 ticket keys. If any ticket is blocked, always name the OLDEST blocked ticket's key.
- Use only numbers from COUNTS or the lists; do not count or add anything yourself. Say "and N more" only with done-not-listed.
- Never invent causes, owners, dates, estimates, effort/hours, opinions or recommendations. Do not describe a ticket in a section it is not in (a blocked ticket is never "done").
- If a section is empty, say so in a short clause. You must still write 3 to 5 sentences.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }`;
}
