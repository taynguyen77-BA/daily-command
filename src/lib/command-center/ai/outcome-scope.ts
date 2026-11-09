// V2.51 A2 — label an AI feature from ITS OWN calls, never from the shared, mutable `provider.mode`.
// `runScoped` runs a provider method on a per-call view of the provider whose `runTask` records the outcome into a local list; two
// overlapping calls therefore each see only their own result. Features show "AI" only when every call of the run succeeded and
// otherwise the calculated content plus the first failure's reason (AiFailureNote).
//
// This file (with claude-provider.ts, provider.ts and index.ts) is the ONLY place allowed to read `provider.mode`: a provider
// without `runTask` (the mock, a test fake) is classified by its declared mode.

import type { AiFailure, AiOutcome } from "./outcome";
import type { AIProvider } from "./provider";

type ScopableProvider = { readonly mode: "mock" | "claude"; runTask?: AIProvider["runTask"] };

export interface OutcomeScope {
  run<P extends ScopableProvider, T>(provider: P, fn: (p: P) => Promise<T>): Promise<T>;
  /** At least one call ran and every call succeeded. */
  readonly ai: boolean;
  /** "claude" iff `ai` (the shape persisted records already use). */
  readonly mode: "mock" | "claude";
  /** The first failed call, when AI was requested and did not answer. */
  readonly failure: AiFailure | undefined;
  /** Whether any call was made (false for a cache hit / a short-circuit). */
  readonly called: boolean;
}

export function createOutcomeScope(): OutcomeScope {
  const outcomes: AiOutcome<unknown>[] = [];
  return {
    async run(provider, fn) {
      if (typeof provider.runTask !== "function") {
        const value = await fn(provider);
        outcomes.push(provider.mode === "claude" ? { ok: true, data: undefined } : { ok: false, reason: "unavailable" });
        return value;
      }
      const scoped = Object.create(provider) as typeof provider;
      scoped.runTask = (async (task: never, input: never) => {
        const o = await provider.runTask!(task, input);
        outcomes.push(o);
        return o;
      }) as AIProvider["runTask"];
      return fn(scoped);
    },
    get ai() {
      return outcomes.length > 0 && outcomes.every((o) => o.ok);
    },
    get mode() {
      return outcomes.length > 0 && outcomes.every((o) => o.ok) ? "claude" : "mock";
    },
    get failure() {
      return outcomes.find((o): o is AiFailure => !o.ok);
    },
    get called() {
      return outcomes.length > 0;
    },
  };
}

/** One run: the value plus how it was produced. */
export async function runScoped<P extends ScopableProvider, T>(provider: P, fn: (p: P) => Promise<T>): Promise<{ value: T; ai: boolean; mode: "mock" | "claude"; failure?: AiFailure }> {
  const scope = createOutcomeScope();
  const value = await scope.run(provider, fn);
  return { value, ai: scope.ai, mode: scope.mode, ...(scope.failure ? { failure: scope.failure } : {}) };
}
