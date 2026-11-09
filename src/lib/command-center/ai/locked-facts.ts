// Shared by task-registry.ts, report-rewrite.ts and report-narrative.ts (kept apart so those three do not import each other in a cycle).

const KEY_RE = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/g;
const uniqStrings = (a: string[]) => Array.from(new Set(a));

/** Every ticket key and every number in `output` must also be in `source` (list numbering at
 *  the start of a line is formatting). I4's locked-facts rule — also used by the browser. */
export function lockedFactViolations(output: string, source: string): string[] {
  const v: string[] = [];
  const srcKeys = new Set(source.match(KEY_RE) ?? []);
  for (const k of uniqStrings(output.match(KEY_RE) ?? [])) if (!srcKeys.has(k)) v.push(`ticket key ${k} is not in the report`);
  const nums = (t: string) => (t.replace(KEY_RE, " ").match(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ""))));
  const srcNums = new Set(nums(source));
  for (const n of uniqStrings(nums(output.replace(/^\s*\d+[.)]\s/gm, " ")))) if (!srcNums.has(n)) v.push(`number ${n} is not in the report`);
  return v;
}
