"use client";

// V2.49 A1 — one muted line saying why the AI wording was not used, and what to do. Presentational only.

import { explainAiFailure, type AiFailureReason } from "@/lib/command-center/ai/outcome";

export function AiFailureNote({ reason, httpStatus, className = "" }: { reason: AiFailureReason; httpStatus?: number; className?: string }) {
  const e = explainAiFailure(reason, httpStatus);
  return (
    <p className={`text-xs text-text3 ${className}`} data-ai-failure={reason}>
      {e.title}. {e.nextStep}
    </p>
  );
}
