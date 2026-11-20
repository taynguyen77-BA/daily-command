// V2.52.1 — /api/command-center/me must never answer a bare HTTP 500: an unexpected failure becomes JSON with a
// plain, secret-free reason that the sign-in gate can show.
import { ok } from "./harness.mts";
import { guardedRoute, redactForLog } from "../../src/lib/server/route-guard.ts";

const G = "route-guard";
const quiet = () => {};

const boom = await guardedRoute(async () => { throw new Error("KV down https://x.upstash.io token=abcdefghijklmnopqrstuvwxyz0123456789"); }, "me", quiet);
const body = (await boom.json()) as { ok: boolean; error: string; errorKind: string };
ok(G, boom.status === 500, "thrown error -> 500");
ok(G, body.ok === false && body.errorKind === "server-error", "JSON body with errorKind");
ok(G, body.error.length > 20 && !/upstash|abcdefghij/.test(body.error), "message is plain and leaks nothing");
ok(G, boom.headers.get("cache-control") === "no-store", "no-store");

const fine = await guardedRoute(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), "me", quiet);
ok(G, fine.status === 200, "normal responses pass through untouched");

ok(G, !/abcdefghijklmnopqrstuvwxyz0123456789/.test(redactForLog(new Error("Bearer abcdefghijklmnopqrstuvwxyz0123456789"))), "log line redacts long tokens");
