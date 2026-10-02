// E5 — constant-time secret comparison for every server-side auth check (sync-auth.ts,
// app-state.ts). A plain `===` on strings returns as soon as the first byte differs, which
// leaks — in principle — how much of a guessed secret was right through response timing.
//
// crypto.timingSafeEqual throws on buffers of different lengths, and branching on the length
// first would itself leak the secret's length. Both sides are hashed to a fixed 32-byte
// SHA-256 digest first, so the comparison is always over equal-length buffers and takes the
// same time whatever the input. Server-only in practice (node:crypto): imported only by
// modules the API routes use, never by a client component.

import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** True when `a` and `b` are the same string, compared in constant time. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** True when `authorizationHeader` is exactly `Bearer <secret>`, compared in constant time.
 *  A missing header or secret is never equal. */
export function bearerMatches(authorizationHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!authorizationHeader || !secret) return false;
  return safeEqual(authorizationHeader, `Bearer ${secret}`);
}
