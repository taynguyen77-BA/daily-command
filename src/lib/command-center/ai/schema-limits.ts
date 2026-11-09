// D2 — the output limits a prompt must state, GENERATED from the task's Zod output schema so the prompt and the
// schema cannot drift (a string over its `max` used to fail the whole answer with an opaque "invalid-output").

import { z } from "zod";

interface JsonSchemaNode {
  type?: string;
  maxLength?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

function walk(node: JsonSchemaNode | undefined, path: string, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "string" && typeof node.maxLength === "number") out.push(`${path || "(value)"}: at most ${node.maxLength} characters`);
  if (node.type === "array" && typeof node.maxItems === "number") out.push(`${path || "(value)"}: at most ${node.maxItems} items`);
  for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, path ? `${path}.${k}` : k, out);
  const items = Array.isArray(node.items) ? node.items[0] : node.items;
  if (items) walk(items, `${path}[]`, out);
  for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(alt, path, out);
}

/** Lines like "summary: at most 600 characters" / "risks: at most 5 items" for every bounded field of the schema. */
export function schemaLimits(schema: z.ZodType): string[] {
  try {
    const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "output" }) as JsonSchemaNode;
    const out: string[] = [];
    walk(json, "", out);
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

/** The text appended to a prompt; empty when the schema has no bounded fields. */
export function schemaLimitsText(schema: z.ZodType): string {
  const lines = schemaLimits(schema);
  if (lines.length === 0) return "";
  return `\n\nOUTPUT LIMITS (enforced — an answer over a limit is rejected; keep every field within it):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

function maxChars(node: JsonSchemaNode | undefined): number {
  if (!node || typeof node !== "object") return 0;
  if (node.type === "string") return typeof node.maxLength === "number" ? node.maxLength : 0;
  if (node.type === "array") {
    const items = Array.isArray(node.items) ? node.items[0] : node.items;
    return (typeof node.maxItems === "number" ? node.maxItems : 0) * maxChars(items);
  }
  if (node.properties) return Object.values(node.properties).reduce((s, p) => s + maxChars(p), 0);
  const alts = [...(node.anyOf ?? []), ...(node.oneOf ?? [])];
  return alts.length ? Math.max(...alts.map(maxChars)) : 0;
}

const maxCharsCache = new WeakMap<object, number>();
/** V2.49 A1 — worst-case number of characters the schema allows (bounded strings x bounded arrays; unbounded fields count 0). Cached per schema. */
export function schemaMaxChars(schema: z.ZodType): number {
  const hit = maxCharsCache.get(schema);
  if (hit !== undefined) return hit;
  let n = 0;
  try {
    n = maxChars(z.toJSONSchema(schema, { unrepresentable: "any", io: "output" }) as JsonSchemaNode);
  } catch {
    n = 0;
  }
  maxCharsCache.set(schema, n);
  return n;
}
