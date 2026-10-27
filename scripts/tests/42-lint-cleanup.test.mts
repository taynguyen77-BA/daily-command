// P2.6 — lint & React-correctness cleanup: guard the specific fixes so they do not regress.
import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const C = "src/components/command-center/";
const group = "P2.6 Lint cleanup";

ok(group, /eslint \. --max-warnings 0/.test(read(".github/workflows/ci.yml")) && /"lint": "eslint \. --max-warnings 0"/.test(read("package.json")), "CI and npm run lint use --max-warnings 0");
ok(group, !/eslint-disable[^\n]*react-hooks\/exhaustive-deps/.test(read(C + "use-command-center.ts").split("sharedMemo")[0] ?? ""), "use-command-center.ts has no unused exhaustive-deps directives left in its sharedMemo slots");
ok(group, (read(C + "use-command-center.ts").match(/eslint-disable-next-line react-hooks\/exhaustive-deps/g) ?? []).length <= 1, "use-command-center.ts keeps at most the one directive that is still needed (the notify effect)");

// the set-state-in-effect fixes
ok(group, !/useEffect\(refreshUsage/.test(read(C + "AiDataProtectionPanel.tsx")) && /Initial load: `usage` already starts as undefined/.test(read(C + "AiDataProtectionPanel.tsx")), "AiDataProtectionPanel: initial load no longer resets state synchronously in the effect");
ok(group, /useSyncExternalStore/.test(read(C + "JiraWriteBackPanel.tsx")) && !/useEffect\(refresh, \[\]\)/.test(read(C + "JiraWriteBackPanel.tsx")), "JiraWriteBackPanel: the localStorage pairing is read as an external store");
ok(group, /const transitionId = pickedTransitionId \|\| preselected\?\.id \|\| ""/.test(read(C + "JiraWriteBackPrompt.tsx")), "JiraWriteBackPrompt: the preselected transition is derived, not copied into state by an effect");
ok(group, /frozenForStep/.test(read(C + "MorningMode.tsx")) && !/if \(step === "triage"\) setTriageKeys[^\n]*\n[^\n]*eslint-disable/.test(read(C + "MorningMode.tsx")), "MorningMode: triage / re-check lists are frozen on step entry during render, guarded by the step");
ok(group, /key=\{selected\?\.item\.id \?\? "none"\}/.test(read("src/app/page.tsx")) && /key=\{selected\?\.item\.id \?\? "none"\}/.test(read("src/app/priorities/page.tsx")) && /useState\(!!item\)/.test(read(C + "TakeActionPanel.tsx")), "TakeActionPanel: keyed per item, so it starts fresh instead of resetting in an effect");
const focus = read(C + "FocusSession.tsx");
ok(group, /useRef<number>\(0\)/.test(focus) && !/useRef<number>\(Date\.now\(\)\)/.test(focus), "FocusSession: no clock read during render");
ok(group, /\[planItemId, today, candidate, hasAttentionItem, relatedAction\?\.relatedWorkItemId\]/.test(focus) && /\[planItemId, running\]/.test(focus), "FocusSession: simple dependency lists");
ok(group, /setElapsedMs\(0\); \/\/ a new session/.test(focus), "FocusSession: the elapsed display still restarts from 0 for a new session");
ok(group, /router\.replace\(`\/signin\?callbackUrl=/.test(read(C + "AuthGate.tsx")) && !/window\.location\.href/.test(read(C + "AuthGate.tsx")), "AuthGate: signed-out redirect uses the router");
const nav = read(C + "Nav.tsx");
ok(group, /eslint-disable-next-line react-hooks\/set-state-in-effect\n\s*setActive\(true\)/.test(nav) && /event-like effect/.test(nav), "Nav: the one-shot morning redirect keeps a single, specific, explained directive");
const settings = read("src/app/data-settings/page.tsx");
ok(group, /setSyncElapsedSec\(0\); \/\/ reset when the sync ends/.test(settings), "data-settings: the sync timer resets in its cleanup");
ok(group, !/&quot;Blocked&quot;/.test("") && /&quot;Blocked&quot;/.test(settings), "the P1.2 copy escapes its quotes (react/no-unescaped-entities)");
