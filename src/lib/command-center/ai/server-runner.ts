// V2.36 H3–H5 — the server side of /api/command-center/ai, split out of the route so every rule
// is tested offline with a fake model (route.ts only wires env, auth and the real SDK in).
//
//   1. Request: { task, input } — the input is validated by the task's own schema and the
//      SERVER builds the prompt (task-registry.ts). The old free-form { task, prompt } shape is
//      served only while AI_LEGACY_PROMPT_PATH=on, and only for pre-V2.36 tasks.
//   2. Inputs get a pattern redaction pass here too (the browser already redacted them).
//   3. Daily token cap (AI_DAILY_TOKEN_CAP) checked BEFORE any model call → 429 when used up.
//   4. Identical requests are deduped: in flight (one model call) and for the task's cache
//      duration (usage-policy.ts). A cache hit is logged with zero tokens, cached: true.
//   5. The stable system prompt is sent with cache_control (prompt caching).
//   6. Output → JSON → the task's output schema → grounding guard (evaluation.ts). A grounding
//      violation gets ONE retry with the violations listed; still violating → 422 and the
//      browser shows its deterministic text. Outputs are only ever returned for display —
//      nothing here, or downstream of it, performs a write.
//   7. Every model response — success or not — is logged to the usage ledger.

import { createHash } from "node:crypto";
import { aiRequestSchema, aiStructuredRequestSchema, type AITask } from "./schemas";
import { buildTaskPrompt, LEGACY_PROMPT_TASKS, parseTaskInput, TASK_OUTPUT_SCHEMAS, visibleTokenBudget } from "./task-registry";
import { isAlwaysThinkingModel, resolveAiModel, supportsDefaultFallbacks, type AiModelEnv, type AiModelTier } from "./model-config";
import { checkGrounding } from "./evaluation";
import { redactPatternsDeep } from "./redaction";
import { UNTRUSTED_DATA_RULE } from "./untrusted";
import { getUsagePolicy } from "./usage-policy";
import { lastSevenDays, resolveDailyTokenCap, summarizeUsage, utcDay, type AiUsageRecord, type UsageLedger } from "./usage-ledger";

export const AI_SYSTEM_PROMPT = `You are a reasoning engine embedded in a BA/PO/PM delivery tool. You
receive a prompt that already contains every fact, piece of evidence, and constraint you are
allowed to use, plus a REQUIRED OUTPUT SCHEMA section. Respond with ONLY a single JSON object
matching that schema — no markdown fences, no prose before or after. Never invent facts not
given to you: every ticket key, person, number and date you mention must appear in the prompt.
If you cannot responsibly answer from the given facts, use the schema's insufficientEvidence
field (when present) rather than guessing.

${UNTRUSTED_DATA_RULE}`;

export interface ModelCallParams {
  model: string;
  maxTokens: number;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  useFallbacks: boolean;
}

export interface ModelCallResult {
  stopReason: string | null;
  text: string | undefined;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface AiServerEnv extends AiModelEnv {
  AI_DAILY_TOKEN_CAP?: string;
  AI_LEGACY_PROMPT_PATH?: string;
}

export interface AiServerDeps {
  env: AiServerEnv;
  callModel: (params: ModelCallParams) => Promise<ModelCallResult>;
  ledger: UsageLedger;
  now: () => Date;
  cache?: ResponseCache;
}

export type AiServerResult = { status: number; body: Record<string, unknown> };

export function legacyPromptPathEnabled(env: AiServerEnv): boolean {
  return /^(1|true|on|yes)$/i.test(env.AI_LEGACY_PROMPT_PATH?.trim() ?? "");
}

// ----- dedupe cache -----

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

export class ResponseCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<AiServerResult>>();
  constructor(private readonly maxEntries = 200) {}
  get(key: string, nowMs: number): unknown | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.data;
  }
  set(key: string, data: unknown, ttlMs: number, nowMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { data, expiresAt: nowMs + ttlMs });
  }
  pending(key: string): Promise<AiServerResult> | undefined {
    return this.inflight.get(key);
  }
  track(key: string, p: Promise<AiServerResult>): void {
    this.inflight.set(key, p);
    p.finally(() => this.inflight.delete(key)).catch(() => {});
  }
}

const sharedCache = new ResponseCache();

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

const fail = (status: number, error: string, errorKind: string, extra: Record<string, unknown> = {}): AiServerResult => ({ status, body: { ok: false, error, errorKind, ...extra } });

export async function handleAiRequest(body: unknown, deps: AiServerDeps): Promise<AiServerResult> {
  // ---- 1. shape ----
  let task: AITask;
  let prompt: string;
  if (body && typeof body === "object" && "input" in body) {
    const req = aiStructuredRequestSchema.safeParse(body);
    if (!req.success) return fail(400, "Request did not match the expected shape { task, input }.", "bad-request");
    task = req.data.task;
    const parsed = parseTaskInput(task, req.data.input);
    if (!parsed.ok) return fail(400, parsed.error, "bad-request");
    prompt = buildTaskPrompt(task, redactPatternsDeep(parsed.input));
  } else if (body && typeof body === "object" && "prompt" in body) {
    const legacy = aiRequestSchema.safeParse(body);
    if (!legacy.success) return fail(400, "Request did not match the expected shape.", "bad-request");
    if (!legacyPromptPathEnabled(deps.env) || !LEGACY_PROMPT_TASKS.has(legacy.data.task)) {
      return fail(400, "Free-form prompts are not accepted. Send { task, input } — the server builds the prompt.", "legacy-prompt-disabled");
    }
    task = legacy.data.task;
    prompt = legacy.data.prompt;
  } else {
    return fail(400, "Request did not match the expected shape { task, input }.", "bad-request");
  }

  const { model, tier } = resolveAiModel(task, deps.env);
  const cap = resolveDailyTokenCap(deps.env.AI_DAILY_TOKEN_CAP);
  const now = deps.now();

  // ---- 3. cap ----
  const records = await deps.ledger.listDays(lastSevenDays(now));
  const summary = summarizeUsage(records, cap, now, deps.ledger.storage);
  if (summary.remainingToday <= 0) {
    return fail(429, `Today's AI budget (${cap.toLocaleString("en-US")} tokens) is used up. Deterministic text is shown until it resets at midnight UTC.`, "budget-exhausted", {
      usage: { cap, usedToday: summary.today.totalTokens, remainingToday: 0 },
    });
  }

  // ---- 4. dedupe ----
  const cache = deps.cache ?? sharedCache;
  const key = createHash("sha256").update(`${task}\u0000${model}\u0000${prompt}`).digest("hex");
  const hit = cache.get(key, now.getTime());
  if (hit !== undefined) {
    await log(deps, { task, model, tier, cached: true, outcome: "ok" }, now);
    return { status: 200, body: { ok: true, data: hit, cached: true, usage: { cap, remainingToday: summary.remainingToday, model, tier } } };
  }
  const pending = cache.pending(key);
  if (pending) return pending;

  const run = callAndValidate(task, prompt, model, tier, deps, now).then(async (r) => {
    if (r.status === 200) cache.set(key, r.body.data, getUsagePolicy(task).cacheDurationMs, deps.now().getTime());
    const after = summarizeUsage(await deps.ledger.listDays(lastSevenDays(deps.now())), cap, deps.now(), deps.ledger.storage);
    return { ...r, body: { ...r.body, usage: { cap, remainingToday: after.remainingToday, model, tier } } };
  });
  cache.track(key, run);
  return run;
}

async function log(deps: AiServerDeps, r: Pick<AiUsageRecord, "task" | "model" | "tier" | "cached" | "outcome"> & Partial<AiUsageRecord>, now: Date): Promise<void> {
  try {
    await deps.ledger.append({
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      at: now.toISOString(),
      day: utcDay(now),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...r,
    });
  } catch {
    // Logging must never turn a good answer into an error.
  }
}

async function callAndValidate(task: AITask, prompt: string, model: string, tier: AiModelTier, deps: AiServerDeps, now: Date): Promise<AiServerResult> {
  const visible = visibleTokenBudget(task);
  const maxTokens = isAlwaysThinkingModel(model) ? visible + 6000 : visible;
  const messages: ModelCallParams["messages"] = [{ role: "user", content: prompt }];
  const schema = TASK_OUTPUT_SCHEMAS[task] as { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: ModelCallResult;
    try {
      res = await deps.callModel({ model, maxTokens, system: AI_SYSTEM_PROMPT, messages, useFallbacks: supportsDefaultFallbacks(model) });
    } catch (err) {
      await log(deps, { task, model, tier, cached: false, outcome: "error" }, now);
      return fail(502, err instanceof Error ? err.message : "Unknown AI provider error.", "provider-error");
    }
    const usage = res.usage;
    const base = { task, model, tier, cached: false, ...usage };
    if (res.stopReason === "refusal") {
      await log(deps, { ...base, outcome: "refused" }, now);
      return fail(502, "The model declined this request.", "refused");
    }
    if (res.stopReason === "max_tokens") {
      await log(deps, { ...base, outcome: "truncated" }, now);
      return fail(502, "Model response was cut off before it finished.", "truncated");
    }
    if (!res.text) {
      await log(deps, { ...base, outcome: "invalid-output" }, now);
      return fail(502, "Model returned no text content.", "invalid-output");
    }
    let json: unknown;
    try {
      json = extractJson(res.text);
    } catch {
      await log(deps, { ...base, outcome: "invalid-output" }, now);
      return fail(502, "Model response was not valid JSON.", "invalid-output");
    }
    const validated = schema.safeParse(json);
    if (!validated.success) {
      await log(deps, { ...base, outcome: "invalid-output" }, now);
      return fail(502, "Model response failed schema validation.", "invalid-output");
    }
    const grounding = checkGrounding(validated.data, prompt);
    if (grounding.ok) {
      await log(deps, { ...base, outcome: "ok" }, now);
      return { status: 200, body: { ok: true, data: validated.data, ...(attempt > 0 ? { retriedForGrounding: true } : {}) } };
    }
    if (attempt === 0) {
      await log(deps, { ...base, outcome: "grounding-retry" }, now);
      messages.push(
        { role: "assistant", content: res.text },
        {
          role: "user",
          content: `Your answer referenced things that are not in the supplied facts:\n${grounding.violations.map((v) => `- ${v}`).join("\n")}\nAnswer again with the same JSON schema, using only ticket keys, people, numbers and dates that appear in the original prompt. If you need one that isn't there, leave it out.`,
        }
      );
      continue;
    }
    await log(deps, { ...base, outcome: "grounding-rejected" }, now);
    return fail(422, "The AI answer referenced facts that were not supplied, so it was rejected.", "grounding-rejected", { violations: grounding.violations.slice(0, 10) });
  }
  return fail(502, "Unknown AI provider error.", "provider-error");
}
