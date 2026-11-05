// Round-3 seed (red-first). Place at scripts/tests/54-grounding-locales.test.mts.
// Bug: the grounding guard strips ISO dates from the FACTS before collecting fact numbers, then flags the digits of a
// Vietnamese date in the OUTPUT ("27/10", "ngày 27 tháng 10") as invented numbers -> every Vietnamese answer that mentions
// a date is rejected (422) and the UI silently shows Mock text. A date that IS in the facts must be accepted in any common
// written form; a date that is NOT in the facts must still be rejected.
import { checkGrounding } from "../../src/lib/command-center/ai/evaluation";
import { ok } from "./harness.mts";

const facts = 'Ticket WF-12 "Update reminder email" is due 2026-10-27, blocked by the API team. Assignee Tay Nguyen.';
const pass = (text: string) => checkGrounding({ text }, facts).ok;

{
  const group = "T5 Grounding: dates in other written forms";
  ok(group, pass("WF-12 hạn chót ngày 27/10, đang bị chặn bởi API team."), "Vietnamese dd/MM of a supplied date is accepted");
  ok(group, pass("WF-12 đến hạn ngày 27 tháng 10."), "Vietnamese 'ngày 27 tháng 10' of a supplied date is accepted");
  ok(group, pass("WF-12 is due 27/10/2026."), "dd/MM/yyyy of a supplied date is accepted");
  ok(group, pass("WF-12 is due on the 27th of October."), "'27th of October' of a supplied date is accepted");
  ok(group, !pass("WF-12 hạn chót ngày 28/10."), "a Vietnamese date that is NOT in the facts is still rejected");
  ok(group, !pass("WF-12 hạn chót ngày 27 tháng 11."), "right day, wrong month is still rejected");
  ok(group, !pass("WF-99 hạn chót ngày 27/10."), "an invented ticket key is still rejected");
}
{
  const group = "T5 Grounding: list markers are not facts";
  ok(group, pass("Step 1: confirm the copy. Step 2: send the reply to Tay Nguyen."), "'Step 1' / 'Step 2' enumeration markers are formatting, not claims");
}
