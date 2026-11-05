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
