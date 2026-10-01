// Server-side AI service layer (BUILD REQUEST V1.1 §5). The Anthropic API key lives only
// in process.env on this server route — it is never sent to, or readable by, the browser.
// The client (src/lib/command-center/ai/claude-provider.ts) only ever POSTs an already-built
// prompt string and gets back JSON; it never talks to Anthropic directly.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import {
  aiRequestSchema,
  assessmentResponseSchema,
  communicationArtifactResponseSchema,
  dailyGuidanceResponseSchema,
  decisionOptionsResponseSchema,
  outcomeInterpretationResponseSchema,
  proactiveAssessmentResponseSchema,
  projectStoryResponseSchema,
  queryAnswerResponseSchema,
  reasoningResponseSchema,
  textResponseSchema,
  trendResponseSchema,
} from "@/lib/command-center/ai/schemas";
import { aiModelStatus, isAlwaysThinkingModel, resolveAiModel, supportsDefaultFallbacks } from "@/lib/command-center/ai/model-config";

export const runtime = "nodejs";

const REASONING_TASKS = new Set(["analyzePriorities", "detectRisks"]);
const TREND_TASKS = new Set(["interpretTrend"]);
const ASSESSMENT_TASKS = new Set(["detectDecisionConflicts", "analyzeActionOutcomes"]);
const QUERY_ANSWER_TASKS = new Set(["answerQuery"]);
const PROACTIVE_ASSESSMENT_TASKS = new Set(["assessProactive"]);
const PROJECT_STORY_TASKS = new Set(["generateProjectStory"]);
const DECISION_OPTIONS_TASKS = new Set(["generateDecisionOptions"]);
const OUTCOME_INTERPRETATION_TASKS = new Set(["interpretOutcome"]);
const DAILY_GUIDANCE_TASKS = new Set(["generateDailyGuidance"]);
const COMMUNICATION_ARTIFACT_TASKS = new Set(["generateCommunicationArtifact"]);
// V1.5 §8-10 — a 2-4 option decision matrix is verbose; give it more room than the other,
// single-paragraph task shapes.
const LARGE_OUTPUT_TASKS = new Set(["generateDecisionOptions"]);
// C4 — the model is no longer hardcoded here: ANTHROPIC_MODEL (reasoning tasks) and
// ANTHROPIC_MODEL_FAST (short narration tasks), with current defaults — see model-config.ts.

const SYSTEM_PROMPT = `You are a reasoning engine embedded in a BA/PO/PM delivery tool. You
receive a prompt that already contains every fact, piece of evidence, and constraint you are
allowed to use, plus a REQUIRED OUTPUT SCHEMA section. Respond with ONLY a single JSON object
matching that schema — no markdown fences, no prose before or after. Never invent facts not
given to you. If you cannot responsibly answer from the given facts, use the schema's
insufficientEvidence field (when present) rather than guessing.`;

export async function GET() {
  const available = Boolean(process.env.ANTHROPIC_API_KEY);
  // Model ids only (never a secret) — Setup Health shows whether they were chosen explicitly.
  return NextResponse.json({ available, ...aiModelStatus({ ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL, ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST }) });
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function POST(req: Request) {
  // V2.18 §4 — this route spends the account owner's Anthropic budget on every call; it had
  // no auth at all before this pass. Same gate/contract as jira/sync (see sync-auth.ts).
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "AI provider unavailable: no API key configured on the server." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }

  const parsedRequest = aiRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json({ ok: false, error: "Request did not match the expected shape." }, { status: 400 });
  }
  const { task, prompt } = parsedRequest.data;

  try {
    // V2.2.1 §4 — an explicit, sane timeout so a slow/hung model call fails fast into the
    // existing catch-block error handling below rather than running until Vercel's own
    // platform function timeout kills it uncleanly (the SDK's own default is 10 minutes).
    const { model } = resolveAiModel(task, { ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL, ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST });
    const client = new Anthropic({ apiKey, timeout: 55_000 });
    // Always-thinking models spend part of max_tokens on thinking, so they get room for it on
    // top of the visible JSON; refusals on those models fall back server-side by category.
    const visibleBudget = LARGE_OUTPUT_TASKS.has(task) ? 1536 : 512;
    const response = await client.beta.messages.create({
      model,
      max_tokens: isAlwaysThinkingModel(model) ? visibleBudget + 6000 : visibleBudget,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      ...(supportsDefaultFallbacks(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json({ ok: false, error: "The model declined this request." }, { status: 502 });
    }
    if (response.stop_reason === "max_tokens") {
      return NextResponse.json({ ok: false, error: "Model response was cut off before it finished." }, { status: 502 });
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json({ ok: false, error: "Model returned no text content." }, { status: 502 });
    }

    let json: unknown;
    try {
      json = extractJson(textBlock.text);
    } catch {
      return NextResponse.json({ ok: false, error: "Model response was not valid JSON." }, { status: 502 });
    }

    const schema = REASONING_TASKS.has(task)
      ? reasoningResponseSchema
      : TREND_TASKS.has(task)
        ? trendResponseSchema
        : ASSESSMENT_TASKS.has(task)
          ? assessmentResponseSchema
          : QUERY_ANSWER_TASKS.has(task)
            ? queryAnswerResponseSchema
            : PROACTIVE_ASSESSMENT_TASKS.has(task)
              ? proactiveAssessmentResponseSchema
              : PROJECT_STORY_TASKS.has(task)
                ? projectStoryResponseSchema
                : DECISION_OPTIONS_TASKS.has(task)
                  ? decisionOptionsResponseSchema
                  : OUTCOME_INTERPRETATION_TASKS.has(task)
                    ? outcomeInterpretationResponseSchema
                    : DAILY_GUIDANCE_TASKS.has(task)
                      ? dailyGuidanceResponseSchema
                      : COMMUNICATION_ARTIFACT_TASKS.has(task)
                        ? communicationArtifactResponseSchema
                        : textResponseSchema;
    const validated = schema.safeParse(json);
    if (!validated.success) {
      return NextResponse.json({ ok: false, error: "Model response failed schema validation." }, { status: 502 });
    }

    return NextResponse.json({ ok: true, data: validated.data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Unknown AI provider error." }, { status: 502 });
  }
}
