// E5 — constant-time secret checks; /api/command-center/jira/status hides the host unless
//      authorized.
// E6 — README "Current version" is the package.json version; the test layout itself.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { bearerMatches, safeEqual } from "../../src/lib/command-center/secure-compare";
import { checkSyncRequestAuth } from "../../src/lib/command-center/jira/sync-auth";
import { checkAppStateAuth } from "../../src/lib/command-center/app-state";
import { buildJiraStatusResponse } from "../../src/lib/command-center/jira/status-response";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

// ----- E5 — constant-time comparison for all secret checks -----
{
  const group = "E5 Constant-time secrets";
  ok(group, safeEqual("s3cret", "s3cret") && !safeEqual("s3cret", "s3creT") && !safeEqual("s3cret", "s3cret-longer") && !safeEqual("", "x"), "safeEqual: equal / different / different length");
  ok(group, bearerMatches("Bearer abc", "abc") && !bearerMatches("Bearer abd", "abc") && !bearerMatches(null, "abc") && !bearerMatches("Bearer ", undefined) && !bearerMatches("abc", "abc"), "bearerMatches: exact 'Bearer <secret>' only; missing header or secret never matches");
  const src = read("src/lib/command-center/secure-compare.ts");
  ok(group, /timingSafeEqual\(digest\(a\), digest\(b\)\)/.test(src) && /createHash\("sha256"\)/.test(src), "comparison is crypto.timingSafeEqual over fixed-length SHA-256 digests (no length leak)");
  // Behavior of both auth checks is unchanged.
  ok(group, checkSyncRequestAuth("Bearer cron", "cron", undefined).ok && checkSyncRequestAuth("Bearer app", "cron", "app").ok && !checkSyncRequestAuth("Bearer nope", "cron", "app").ok, "checkSyncRequestAuth: either secret still works, a wrong one still fails");
  ok(group, checkSyncRequestAuth("Bearer cron", " cron\n", undefined).ok, "…and a pasted trailing newline is still forgiven");
  ok(group, checkAppStateAuth("Bearer app", "app").ok && !checkAppStateAuth("Bearer apx", "app").ok && (checkAppStateAuth("Bearer app", undefined) as { status?: number }).status === 503, "checkAppStateAuth: same results as before");
  ok(group, /bearerMatches\(authorizationHeader, cronSecret\)/.test(read("src/lib/command-center/jira/sync-auth.ts")) && /bearerMatches\(authorizationHeader, appStateSecret\)/.test(read("src/lib/command-center/app-state.ts")), "both auth checks go through bearerMatches");
  const offenders = walk("src").filter((f) => /[!=]==\s*`Bearer \$\{|`Bearer \$\{[^}]+\}`\s*[!=]==/.test(read(f)));
  ok(group, offenders.length === 0, `no secret is compared with === / !== anywhere in src (${offenders.join(", ") || "none"})`);
}

// ----- E5 — /api/command-center/jira/status -----
{
  const group = "E5 Jira status route";
  const config = { baseUrl: "https://acme.atlassian.net" };
  ok(group, JSON.stringify(buildJiraStatusResponse(null, false)) === '{"configured":false}', "not configured → { configured: false }");
  ok(group, JSON.stringify(buildJiraStatusResponse(config, false)) === '{"configured":true}', "unauthenticated → { configured: true } only, no baseUrlHost");
  ok(group, buildJiraStatusResponse(config, true).baseUrlHost === "acme.atlassian.net", "authorized → the host too");
  const route = read("src/app/api/command-center/jira/status/route.ts");
  ok(group, /checkSyncRequestAuth\(req\.headers\.get\("authorization"\), process\.env\.CRON_SECRET, process\.env\.APP_STATE_SECRET\)/.test(route) && /buildJiraStatusResponse\(getJiraConfig\(\), auth\.ok\)/.test(route), "the route uses the same auth as every other route and the tested response builder");
  ok(group, /fetch\(STATUS_ENDPOINT, \{ method: "GET", headers: \{ \.\.\.pairedAuthHeader\(\) \} \}\)/.test(read("src/lib/command-center/datasource/jira-source.ts")), "a paired device sends its auth so it still sees the host");
}

// ----- E6 — README "Current version" equals package.json "version" -----
{
  const group = "E6 Version line";
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const readme = read("README.md");
  const lines = readme.match(/^\*\*Current version:\*\* .*$/gm) ?? [];
  const [major, minor, patch] = pkg.version.split(".");
  const expected = `V${major}.${minor}${patch && patch !== "0" ? `.${patch}` : ""}`;
  const actual = lines[0]?.match(/V\d+\.\d+(?:\.\d+)?/)?.[0];
  ok(group, /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version !== "0.1.0", `package.json carries the real release version (${pkg.version})`);
  ok(group, lines.length === 1, `README has exactly one "Current version" line (found ${lines.length})`);
  ok(group, actual === expected, `README "Current version" (${actual}) equals package.json "version" (${pkg.version} → ${expected})`);
  const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
  ok(group, lock.version === pkg.version && lock.packages[""]?.version === pkg.version, "package-lock.json agrees");
}

// ----- E6 — one runner over per-domain files -----
{
  const group = "E6 Test layout";
  const runner = read("scripts/tests/run.mts");
  const listed = Array.from(runner.matchAll(/"\.\/([^"]+\.test\.mts)"/g)).map((m) => m[1]);
  const onDisk = fs.readdirSync(path.join(process.cwd(), "scripts/tests")).filter((f) => f.endsWith(".test.mts")).sort();
  ok(group, JSON.stringify([...listed].sort()) === JSON.stringify(onDisk), `the runner lists every *.test.mts file exactly once (${onDisk.length} files)`);
  ok(group, !fs.existsSync(path.join(process.cwd(), "scripts/command-center-test.mts")) && /"test": "tsx scripts\/tests\/run\.mts"/.test(read("package.json")), "npm test runs the single runner; the old monolith is gone");
}

// ----- V2.34 — every daily-flow feature has its README entry -----
{
  const group = "V2.34 README entries";
  const readme = read("README.md");
  const start = readme.indexOf("## Daily flow (V2.34)");
  const section = start >= 0 ? readme.slice(start, readme.indexOf("\n## ", start + 5)) : "";
  for (const [feature, title] of [["F1", "**Morning Mode**"], ["F2", "**Blocker follow-ups**"], ["F3", "**Mention reply auto-detection**"], ["F4", "**Jira write-back**"], ["F5", "**Report summaries**"], ["F6", "**Performance budget.**"]] as const) {
    ok(group, section.includes(`- ${title}`), `${feature}: README has a "${title.replace(/\*/g, "")}" entry under "Daily flow (V2.34)"`);
  }
  ok(group, /\*\(OFF by default\)\*/.test(section), "the README states Jira write-back is off by default");
}
