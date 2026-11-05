// Round-3 seed (red-first). Place at scripts/tests/53-forecast-old-tickets.test.mts, append to FILES in run.mts after 52-*.
// Bug: slipRiskFor uses max(0, P50 - age). A ticket OLDER than every comparable ticket gets "0 days left to go" -> LOW,
// while a 1-day-old ticket is HIGH. The estimate must be conditional on survival (T > age) and "no precedent" must never be LOW.
import { buildLeadTimeIndex, type LeadTimeSample } from "../../src/lib/command-center/forecast/lead-time";
import { slipRiskFor } from "../../src/lib/command-center/forecast/slip-risk";
import { agingFor } from "../../src/lib/command-center/forecast/aging";
import { ok } from "./harness.mts";

const samples: LeadTimeSample[] = Array.from({ length: 12 }, (_, i) => ({ projectId: "p", type: "task", days: i + 2 })); // 2..13 days
const est = buildLeadTimeIndex(samples).estimateFor("p", "task");
const today = "2026-11-05";
const d = (n: number) => { const t = new Date("2026-11-05T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const item = (ageDays: number, dueInDays: number) => ({ createdDate: d(-ageDays), dueDate: d(dueInDays), lastUpdated: d(-1) });

{
  const group = "T1 Forecast: old tickets";
  const older = slipRiskFor(item(20, 3), today, est);
  ok(group, older !== null && older.level !== "LOW", `a ticket older than every comparable ticket (20d vs max 13d) due in 3 days is not LOW (got ${older?.level})`);
  ok(group, slipRiskFor(item(45, 2), today, est)?.level === "HIGH", "45 days old, due in 2 days -> HIGH");
  ok(group, slipRiskFor(item(45, 30), today, est)?.level !== "LOW", "far past any precedent, even with 30 days left -> not LOW (no precedent is not safety)");
  const aging = agingFor(item(20, 3), today, est);
  ok(group, aging?.olderThanP85 === true && slipRiskFor(item(20, 3), today, est)?.level !== "LOW", "the aging flag and the slip level never contradict each other on the same ticket");
  // conditional remaining time: among tickets that took > 12 days only 13 qualifies -> remaining 1 day; must not be derived from P50 - age
  const near = slipRiskFor(item(11, 0), today, est);
  ok(group, near !== null && near.level !== "LOW", `due today at age 11d (P85=12): not LOW (got ${near?.level})`);
  ok(group, slipRiskFor(item(1, 30), today, est)?.level === "LOW", "a young ticket with a month left stays LOW");
}
