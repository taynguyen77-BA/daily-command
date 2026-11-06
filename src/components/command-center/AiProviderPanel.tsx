"use client";

// D1 — Data & Settings → AI provider: set the Anthropic key without touching env vars, see exactly why AI does or does not work,
// and test it. The key is WRITE-ONLY: it lives in this component's state only while the user types it, is sent once over PUT,
// then is cleared; it is never read back (the server returns last4 + a fingerprint). D2 adds the AI health section.

import { useCallback, useEffect, useState } from "react";
import { pairedAuthHeader } from "@/lib/command-center/device-pairing";
import { refreshAiAvailability, clearAiFailures, getAiFailures, subscribeAiFailures } from "@/lib/command-center/ai/claude-provider";
import { fetchAiHealth, fetchAiUsage } from "@/lib/command-center/ai/ticket-ai-client";
import type { AiTaskHealth, AiUsageSummary } from "@/lib/command-center/ai/usage-ledger";
import { Panel, SectionHeading } from "./ui";
import { invalidateAiStatusCache } from "./use-ai-readiness";
import { AiSelfTest } from "./AiSelfTest";

const ENDPOINT = "/api/command-center/ai/provider";
const MODEL_SUGGESTIONS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];

interface ProviderStatus {
  configured: boolean;
  source: "member" | "org" | "global" | "env" | null;
  overridesEnv?: boolean;
  last4: string | null;
  fingerprint: string | null;
  verifiedAt: string | null;
  lastError: { kind: string; message: string; at: string } | null;
  canStoreKey: boolean;
  storeAvailable: boolean;
  missing?: string;
  customBaseUrlAllowed: boolean;
  baseUrl: string | null;
  models: { model: string; fastModel: string; deepModel: string };
  savedModels: { fast?: string; default?: string; deep?: string };
  cap: number;
  hardCap: number;
  canManageOrgKey?: boolean;
}
interface TierTest { ok: boolean; model: string; ms?: number; kind?: string; message?: string }
interface TestResult { ok: boolean; tiers: Record<string, TierTest>; models: string[]; listError?: { message: string } }

const SOURCE_TEXT: Record<string, string> = { member: "your saved key", org: "the organization key", global: "the saved key", env: "the server environment (ANTHROPIC_API_KEY)" };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json", ...pairedAuthHeader() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const OUTCOME_LABEL: Record<string, string> = { ok: "ok", "grounding-rejected": "rejected by the fact check", "grounding-retry": "needed a fact-check retry", "invalid-output": "invalid output", "schema-retry": "needed a repair", refused: "declined", truncated: "cut off", error: "provider error" };
const KIND_LABEL: Record<string, string> = { date: "dates", number: "numbers", key: "ticket keys", person: "people" };

export function AiProviderPanel() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<{ fast: string; default: string; deep: string }>({ fast: "", default: "", deep: "" });
  const [capText, setCapText] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [health, setHealth] = useState<AiTaskHealth[] | null>(null);
  const [, bump] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await call("GET", ENDPOINT);
      if (r.status !== 200 || r.json.ok !== true) {
        setLoadError(String(r.json.error ?? `Could not read the AI provider status (HTTP ${r.status}).`));
        return;
      }
      const s = r.json as unknown as ProviderStatus;
      setStatus(s);
      setLoadError(null);
      setModels({ fast: s.savedModels.fast ?? "", default: s.savedModels.default ?? "", deep: s.savedModels.deep ?? "" });
      setCapText(s.cap !== s.hardCap ? String(s.cap) : "");
      setBaseUrl(s.baseUrl ?? "");
    } catch {
      setLoadError("Could not reach the server.");
    }
    setUsage(await fetchAiUsage());
    setHealth(await fetchAiHealth());
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of the server status (state is set after the awaited request)
    void load();
    return subscribeAiFailures(() => bump((n) => n + 1));
  }, [load]);

  const afterChange = () => {
    refreshAiAvailability();
    invalidateAiStatusCache();
  };

  const runTest = async () => {
    setBusy("test");
    const r = await call("POST", `${ENDPOINT}/test`);
    setBusy(null);
    if (r.json.tiers) setTest(r.json as unknown as TestResult);
    else setMessage({ tone: "bad", text: String(r.json.error ?? "The test could not run.") });
    if (r.json.ok === true) clearAiFailures();
    afterChange();
    await load();
  };

  const save = async () => {
    setMessage(null);
    const cap = capText.trim() === "" ? undefined : Number(capText.replace(/[,_\s]/g, ""));
    const body: Record<string, unknown> = {
      ...(apiKey.trim() ? { apiKey } : {}),
      models: { fast: models.fast.trim(), default: models.default.trim(), deep: models.deep.trim() },
      ...(cap !== undefined ? { dailyTokenCap: cap } : {}),
      ...(status?.customBaseUrlAllowed ? { baseUrl: baseUrl.trim() } : {}), // "" removes a saved URL
    };
    setBusy("save");
    const r = await call("PUT", ENDPOINT, body);
    setBusy(null);
    if (r.status !== 200 || r.json.ok !== true) {
      setMessage({ tone: "bad", text: String(r.json.error ?? "Could not save.") });
      return;
    }
    setApiKey(""); // write-only: the key leaves this component's state the moment it is saved
    setMessage({ tone: "ok", text: "Saved. Testing the connection…" });
    afterChange();
    await runTest();
  };

  const remove = async () => {
    if (!window.confirm("Remove the saved API key? AI falls back to the server environment key, or to Mock AI if there is none.")) return;
    setBusy("remove");
    const r = await call("DELETE", ENDPOINT, {});
    setBusy(null);
    setTest(null);
    setMessage(r.status === 200 ? { tone: "ok", text: "Saved key removed." } : { tone: "bad", text: String(r.json.error ?? "Could not remove the key.") });
    afterChange();
    await load();
  };

  const failures = getAiFailures();
  const chip = !status ? null : !status.configured ? { text: "Not connected — AI runs in Mock mode", cls: "text-yellow" } : status.lastError ? { text: `Problem: ${status.lastError.message}`, cls: "text-red" } : status.verifiedAt ? { text: "Connected & verified", cls: "text-green" } : { text: "Key present — not tested yet", cls: "text-yellow" };

  return (
    <Panel className="p-5" data-ai-provider-panel>
      <SectionHeading title="AI provider" subtitle="Anthropic or a compatible gateway. The key is stored encrypted on the server, never shown again, and never sent to this browser." />
      {loadError && <p className="text-sm text-red">{loadError}</p>}
      {!status && (
        <div className="mt-3 space-y-2 text-sm text-text2" data-provider-unavailable>
          <p className="rounded border border-border bg-surface2 p-2 text-xs">
            The form below is disabled until the server status can be read. Fix: set <code>APP_STATE_SECRET</code> (single-user) or turn on team sign-in on the server, make sure a KV store is configured, redeploy, then pair this device in the <strong>Cross-Device Sync</strong> section of this page and reload.
          </p>
          <fieldset disabled className="space-y-2 opacity-70">
            <label className="block"><span className="text-text">API key</span><input type="password" placeholder="sk-ant-… (or your gateway key)" className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 font-mono text-sm" aria-label="Anthropic API key (disabled)" /></label>
            <label className="block" data-base-url-field><span className="text-text">Base URL <span className="text-text3">(optional — for a compatible gateway)</span></span><input placeholder="https://aiproviders.s3corp.com.vn/v1  (empty = api.anthropic.com)" className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 font-mono text-sm" aria-label="Custom base URL (disabled)" /></label>
          </fieldset>
        </div>
      )}
      {status && (
        <div className="space-y-3 text-sm text-text2">
          <p>
            <span className={`font-semibold ${chip!.cls}`}>● {chip!.text}</span>
            {status.configured && status.source && <span className="text-text3"> · using {SOURCE_TEXT[status.source]}{status.last4 ? ` …${status.last4}` : ""}{status.fingerprint ? ` (id ${status.fingerprint})` : ""}{status.verifiedAt ? ` · verified ${new Date(status.verifiedAt).toLocaleString()}` : ""}</span>}
          </p>
          {status.overridesEnv && <p className="text-xs text-text3">The saved key overrides the server environment key. Remove it to fall back to the environment key.</p>}
          {!status.canStoreKey && (
            <p className="rounded border border-border bg-surface2 p-2 text-xs" data-cannot-store>
              {status.storeAvailable ? <>Saving a key here needs an encryption secret on the server: set <code>{status.missing ?? "AUTH_ENCRYPTION_KEY"}</code> and redeploy. Until then, set <code>ANTHROPIC_API_KEY</code> on the server instead.</> : <>Saving a key here needs the server&apos;s key-value store (Vercel KV / Upstash). Until then, set <code>ANTHROPIC_API_KEY</code> on the server instead.</>}
            </p>
          )}
          {failures.length > 0 && (
            <p className="text-xs text-text3" data-recent-failures>
              Recent AI call failures (newest last): {failures.slice(-5).map((f) => `${f.task}: ${f.errorKind}${f.httpStatus ? ` (${f.httpStatus})` : ""}`).join(" · ")}
            </p>
          )}

          <fieldset disabled={!status.canStoreKey || busy !== null} className="space-y-2">
            <label className="block">
              <span className="text-text">API key</span>
              <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={status.last4 ? `saved …${status.last4} — paste a new key to replace it` : "sk-ant-… (or your gateway key)"} className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 font-mono text-sm" aria-label="Anthropic API key (write-only)" />
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["fast", "default", "deep"] as const).map((tier) => (
                <label key={tier} className="block">
                  <span className="text-text">{tier === "fast" ? "Fast" : tier === "default" ? "Default" : "Deep"} model</span>
                  <input list="ai-model-suggestions" value={models[tier]} onChange={(e) => setModels({ ...models, [tier]: e.target.value })} placeholder={tier === "fast" ? status.models.fastModel : tier === "default" ? status.models.model : status.models.deepModel} className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 font-mono text-xs" aria-label={`${tier} model id`} />
                </label>
              ))}
              <datalist id="ai-model-suggestions">
                {Array.from(new Set([...(test?.models ?? []), ...MODEL_SUGGESTIONS])).map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
            <label className="block">
              <span className="text-text">Daily budget (tokens)</span>
              <input value={capText} onChange={(e) => setCapText(e.target.value)} inputMode="numeric" placeholder={String(status.hardCap)} className="mt-1 w-40 rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Daily token budget" />
              <span className="ml-2 text-xs text-text3">server hard cap {status.hardCap.toLocaleString("en-US")}{usage ? ` · today ${usage.today.totalTokens.toLocaleString("en-US")} used` : ""}</span>
            </label>
            {usage && status.cap > 0 && <div className="h-1.5 w-48 overflow-hidden rounded bg-surface2" aria-hidden><div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((100 * usage.today.totalTokens) / status.cap))}%` }} /></div>}
            <label className="block" data-base-url-field>
              <span className="text-text">Base URL <span className="text-text3">(optional — for a compatible gateway)</span></span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={!status.customBaseUrlAllowed} placeholder="https://aiproviders.s3corp.com.vn/v1  (empty = api.anthropic.com)" spellCheck={false} className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 font-mono text-sm disabled:opacity-60" aria-label="Custom base URL" />
              {!status.customBaseUrlAllowed && <span className="text-xs text-text3">Not allowed for your account on this server (ask an admin, or set AI_ALLOW_CUSTOM_BASE_URL=true).</span>}
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void save()} className="rounded bg-accent px-3 py-1 text-sm font-semibold text-white disabled:opacity-50">{busy === "save" ? "Saving…" : "Save & test"}</button>
              <button type="button" onClick={() => void runTest()} disabled={!status.configured} className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50">{busy === "test" ? "Testing…" : "Test connection"}</button>
              {status.source && status.source !== "env" && <button type="button" onClick={() => void remove()} className="rounded border border-border px-3 py-1 text-sm text-red">Remove key</button>}
            </div>
          </fieldset>

          {message && <p className={message.tone === "ok" ? "text-green" : "text-red"} role="status">{message.text}</p>}
          {test && (
            <ul className="space-y-0.5 text-xs" data-provider-test>
              {Object.entries(test.tiers).map(([tier, t]) => (
                <li key={tier} className={t.ok ? "text-green" : "text-red"}>
                  {t.ok ? "✓" : "✗"} {tier} · <span className="font-mono">{t.model}</span> · {t.ok ? `${t.ms} ms` : t.message}
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary className="cursor-pointer text-text3">Where is my key stored?</summary>
            <p className="mt-1 text-xs text-text3">Encrypted (AES-256-GCM, bound to your account scope) in the server&apos;s key-value store. It is write-only: the app only ever shows its last 4 characters and an id. It is not part of backups, exports, cross-device sync or logs. Removing it deletes the stored copy.</p>
          </details>
          <AiSelfTest configured={status.configured} onDone={() => void load()} />
          <div data-ai-health>
            <p className="text-text">AI health (last 7 days)</p>
            {!health || health.length === 0 ? (
              <p className="text-xs text-text3">No model calls yet.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs text-text3">
                {health.map((h) => {
                  const bad = Object.entries(h.byOutcome).filter(([k]) => k !== "ok");
                  return (
                    <li key={h.task}>
                      <span className="text-text2">{h.task}</span>: ok {Math.round(((h.byOutcome.ok ?? 0) * 100) / h.calls)}% of {h.calls}
                      {bad.length > 0 && ` · ${bad.map(([k, n]) => `${OUTCOME_LABEL[k] ?? k} ${n}`).join(", ")}`}
                      {h.topViolations.length > 0 && ` · reasons: ${h.topViolations.map((v) => `${KIND_LABEL[v.kind] ?? v.kind}: ${v.count}`).join(", ")}`}
                      {h.repaired > 0 && ` · repaired ${h.repaired}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
