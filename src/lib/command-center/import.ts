// Data Import (BUILD REQUEST §16). Supports JSON, CSV, and pasted text/Markdown.
// Every path validates before merging — malformed input must never crash the app (§25).

import { z } from "zod";
import type { CommandCenterData, WorkItem } from "./types";
import { emptyData } from "./types";

export interface ImportResult {
  ok: boolean;
  data: CommandCenterData;
  errors: string[];
  addedCounts: Record<string, number>;
}

const workItemSchema = z.object({
  id: z.string().optional(),
  key: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().optional().default("unassigned"),
  clientId: z.string().optional().default("unassigned"),
  type: z.enum(["story", "bug", "task", "production-issue", "release"]).optional().default("task"),
  status: z.enum(["Not Started", "In Progress", "Blocked", "In Review", "Done"]).optional().default("Not Started"),
  priority: z.enum(["P1", "P2", "P3", "P4"]).optional().default("P3"),
  owner: z.string().optional(),
  dueDate: z.string().optional(),
  createdDate: z.string().optional(),
  lastUpdated: z.string().optional(),
  blocked: z.boolean().optional().default(false),
  blockerReason: z.string().optional(),
  dependencyIds: z.array(z.string()).optional().default([]),
  riskIds: z.array(z.string()).optional().default([]),
  businessImpact: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional().default(3),
  uatCompletionPct: z.number().min(0).max(100).optional(),
  scopeChangeCount: z.number().optional().default(0),
});

const importSchema = z.object({
  clients: z.array(z.object({ id: z.string(), name: z.string() })).optional().default([]),
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        clientId: z.string(),
        releaseDate: z.string().optional(),
        status: z.enum(["on-track", "at-risk", "delayed", "complete"]).optional().default("on-track"),
      })
    )
    .optional()
    .default([]),
  workItems: z.array(workItemSchema).optional().default([]),
  requirements: z.array(z.any()).optional().default([]),
  risks: z.array(z.any()).optional().default([]),
  dependencies: z.array(z.any()).optional().default([]),
  decisions: z.array(z.any()).optional().default([]),
  actions: z.array(z.any()).optional().default([]),
  communications: z.array(z.any()).optional().default([]),
});

function fillWorkItem(w: z.infer<typeof workItemSchema>, today: string, idx: number): WorkItem {
  return {
    id: w.id ?? `import-${w.key}-${idx}`,
    key: w.key,
    title: w.title,
    projectId: w.projectId,
    clientId: w.clientId,
    type: w.type,
    status: w.status,
    priority: w.priority,
    owner: w.owner,
    dueDate: w.dueDate,
    createdDate: w.createdDate ?? today,
    lastUpdated: w.lastUpdated ?? today,
    blocked: w.blocked,
    blockerReason: w.blockerReason,
    dependencyIds: w.dependencyIds,
    riskIds: w.riskIds,
    businessImpact: w.businessImpact,
    uatCompletionPct: w.uatCompletionPct,
    scopeChangeCount: w.scopeChangeCount ?? 0,
  };
}

export function importFromJson(text: string, today: string): ImportResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, data: emptyData(), errors: [`Invalid JSON: ${(e as Error).message}`], addedCounts: {} };
  }
  const result = importSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues.slice(0, 20)) {
      errors.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { ok: false, data: emptyData(), errors, addedCounts: {} };
  }
  const v = result.data;
  const data: CommandCenterData = {
    clients: v.clients,
    projects: v.projects,
    workItems: v.workItems.map((w, i) => fillWorkItem(w, today, i)),
    requirements: v.requirements,
    risks: v.risks,
    dependencies: v.dependencies,
    decisions: v.decisions,
    actions: v.actions,
    communications: v.communications,
  };
  return {
    ok: true,
    data,
    errors,
    addedCounts: {
      clients: data.clients.length,
      projects: data.projects.length,
      workItems: data.workItems.length,
    },
  };
}

/** Minimal CSV parser — no external dependency. Expects a header row. */
function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

export function importFromCsv(text: string, today: string): ImportResult {
  const errors: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parseCsvRows(text);
  } catch (e) {
    return { ok: false, data: emptyData(), errors: [`Could not parse CSV: ${(e as Error).message}`], addedCounts: {} };
  }
  if (rows.length === 0) {
    return { ok: false, data: emptyData(), errors: ["CSV must have a header row and at least one data row."], addedCounts: {} };
  }

  const workItems: WorkItem[] = [];
  rows.forEach((row, i) => {
    const candidate = {
      key: row.key || row.Key || `IMPORT-${i + 1}`,
      title: row.title || row.Title,
      projectId: row.projectId || row.project || "unassigned",
      clientId: row.clientId || row.client || "unassigned",
      type: (row.type || "task") as WorkItem["type"],
      status: (row.status || "Not Started") as WorkItem["status"],
      priority: (row.priority || "P3") as WorkItem["priority"],
      owner: row.owner || undefined,
      dueDate: row.dueDate || undefined,
      blocked: row.blocked === "true",
      businessImpact: (Number(row.businessImpact) || 3) as WorkItem["businessImpact"],
      dependencyIds: [] as string[],
      riskIds: [] as string[],
      scopeChangeCount: Number(row.scopeChangeCount) || 0,
    };
    const parsed = workItemSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(`Row ${i + 2}: ${parsed.error.issues.map((iss) => iss.message).join("; ")}`);
      return;
    }
    workItems.push(fillWorkItem(parsed.data, today, i));
  });

  const data = { ...emptyData(), workItems };
  return { ok: workItems.length > 0, data, errors, addedCounts: { workItems: workItems.length } };
}

/**
 * Pasted text / Markdown quick-capture: each bullet or checklist line becomes a new
 * work item (title only, sensible defaults). Not a full structured import — for that,
 * use JSON or CSV. Lines that don't look like list items are ignored.
 */
export function importFromText(text: string, today: string): ImportResult {
  const lines = text.split(/\r?\n/);
  const workItems: WorkItem[] = [];
  let n = 0;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+)$/);
    if (!m) continue;
    const title = m[1].trim();
    if (!title) continue;
    n += 1;
    workItems.push({
      id: `paste-${today}-${n}`,
      key: `NOTE-${n}`,
      title,
      projectId: "unassigned",
      clientId: "unassigned",
      type: "task",
      status: "Not Started",
      priority: "P3",
      createdDate: today,
      lastUpdated: today,
      blocked: false,
      dependencyIds: [],
      riskIds: [],
      businessImpact: 3,
      scopeChangeCount: 0,
    });
  }
  if (workItems.length === 0) {
    return {
      ok: false,
      data: emptyData(),
      errors: ["No list items found. Use a bullet ('- ') or checklist ('- [ ] ') per line."],
      addedCounts: {},
    };
  }
  return { ok: true, data: { ...emptyData(), workItems }, errors: [], addedCounts: { workItems: workItems.length } };
}
