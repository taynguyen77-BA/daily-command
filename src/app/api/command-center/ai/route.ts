// Server-side AI service layer (BUILD REQUEST V1.1 §5). The Anthropic API key lives only
// in process.env on this server route — it is never sent to, or readable by, the browser.
// The client (src/lib/command-center/ai/claude-provider.ts) only ever POSTs an already-built
// prompt string and gets back JSON; it never talks to Anthropic directly.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  aiRequestSchema,
  assessmentResponseSchema,
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
// V1.5 §8-10 — a 2-4 option decision matrix is verbose; give it more room than the other,
// single-paragraph task shapes.
const LARGE_OUTPUT_TASKS = new Set(["generateDecisionOptions"]);
const MODEL = "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `You are a reasoning engine embedded in a BA/PO/PM delivery tool. You
receive a prompt that already contains every fact, piece of evidence, and constraint you are
allowed to use, plus a REQUIRED OUTPUT SCHEMA section. Respond with ONLY a single JSON object
matching that schema — no markdown fences, no prose before or after. Never invent facts not
given to you. If you cannot responsibly answer from the given facts, use the schema's
insufficientEvidence field (when present) rather than guessing.`;

export async function GET() {
  const available = Boolean(process.env.ANTHROPIC_API_KEY);
  return NextResponse.json({ available });
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function POST(req: Request) {
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
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: LARGE_OUTPUT_TASKS.has(task) ? 1536 : 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

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
