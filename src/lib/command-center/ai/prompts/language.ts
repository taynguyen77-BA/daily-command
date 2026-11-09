// V2.51 A3 — one shared line for prompts that can answer in Vietnamese. Empty for English / omitted, so an English prompt is unchanged.

export type AiLanguage = "en" | "vi";

export function languageLine(language: AiLanguage | undefined): string {
  return language === "vi" ? "\nWrite in Vietnamese (tiếng Việt); never translate ticket keys, product names or code identifiers. Enumerated field values stay in English.\n" : "";
}
