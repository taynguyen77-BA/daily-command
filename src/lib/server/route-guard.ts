// Turns an unexpected exception inside an API route into a JSON answer with a plain reason, instead of
// Next's empty HTTP 500 (which the sign-in gate could only show as "HTTP 500"). The reason is generic and
// secret-free; the real error goes to the server log with long tokens and URLs redacted.

/** Error name + message with URLs, bearer values and long token-like strings removed. */
export function redactForLog(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const text = `${e.name}: ${e.message}`
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_\-=]{24,}/g, "<redacted>");
  return text.slice(0, 240);
}

export async function guardedRoute(run: () => Promise<Response>, label: string, log: (line: string) => void = console.error): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    log(`[command-center] ${label} failed — ${redactForLog(err)}`);
    return Response.json(
      {
        ok: false,
        errorKind: "server-error",
        error: "The server hit an error while loading your account. Check the deployment logs, and that Vercel KV (KV_REST_API_URL / KV_REST_API_TOKEN), NEXTAUTH_SECRET and NEXTAUTH_URL are set correctly.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
