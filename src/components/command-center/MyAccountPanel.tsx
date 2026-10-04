"use client";

// L6 — Data & Settings → My account (team sign-in only): the member's own Jira connection
// (connect / verify / disconnect, or the shared connection with their accountId when the server
// allows it), Slack (personal webhook / team channel / off, with Test), server notifications,
// the daily snapshot and timezone. Secrets go to the server once and never come back: the panel
// only ever sees "connected" and the non-secret details.

import { useState } from "react";
import { connectJira, disconnectJira, testSlack, updateMe, type Me } from "@/lib/command-center/auth/auth-client";
import { useAuthSession } from "./AuthGate";
import { Panel, SectionHeading } from "./ui";

export function MyAccountPanel() {
  const session = useAuthSession();
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [sharedAccountId, setSharedAccountId] = useState("");
  const [webhook, setWebhook] = useState("");
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const { me, setMe } = session;
  const { profile, options, user } = me;

  const run = async (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string) => {
    setBusy(true);
    setStatus(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      const d = r.data as Partial<Me>;
      if (d.profile && d.user && d.options) setMe({ ...me, user: d.user, profile: d.profile, options: d.options });
      setStatus({ text: done, tone: "ok" });
    } else setStatus({ text: r.error, tone: "error" });
  };

  return (
    <Panel className="p-5" data-my-account>
      <SectionHeading title="My account" subtitle={`Signed in as ${user.email} (${user.role === "admin" ? "admin" : "member"}). Your data and settings here are yours alone.`} />
      <div className="space-y-4 text-sm text-text2">
        <div data-my-jira>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Jira connection{options.jiraHost ? ` — ${options.jiraHost}` : ""}</p>
          {profile.jira.connected ? (
            <div className="mt-1">
              <p>
                <span className="text-green">Connected</span> ({profile.jira.mode === "personal" ? "your own API token" : "shared server connection, read-only"}) as <span className="text-text">{profile.jira.displayName ?? "—"}</span> · accountId <span className="font-mono text-xs">{profile.jira.accountId}</span>
                {profile.jira.verifiedAt ? ` · verified ${new Date(profile.jira.verifiedAt).toLocaleString()}` : ""}
              </p>
              <button disabled={busy} onClick={() => void run(disconnectJira, "Jira disconnected.")} className="btn btn-sm btn-secondary mt-1">
                Disconnect
              </button>
            </div>
          ) : (
            <p className="mt-1">Not connected — Jira sync, ticket AI and write-back use your own Jira account.</p>
          )}
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => connectJira(jiraEmail, jiraToken), "Jira connected and verified.").then(() => setJiraToken(""));
            }}
          >
            <label className="text-xs">
              Atlassian email
              <input type="email" value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)} required className="mt-0.5 block rounded border border-border bg-surface px-2 py-1 text-sm" />
            </label>
            <label className="text-xs">
              API token
              <input type="password" autoComplete="off" value={jiraToken} onChange={(e) => setJiraToken(e.target.value)} required className="mt-0.5 block rounded border border-border bg-surface px-2 py-1 text-sm" />
            </label>
            <button type="submit" disabled={busy} className="btn btn-sm btn-primary">
              {profile.jira.mode === "personal" ? "Reconnect & verify" : "Connect & verify"}
            </button>
          </form>
          <p className="mt-1 text-xs text-text3">Checked against this server&apos;s Jira (/myself); your accountId and name come from Jira. The token is stored encrypted and never shown again.</p>
          {options.allowSharedJira && profile.jira.mode !== "personal" && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => updateMe({ jira: { mode: "shared", accountId: sharedAccountId } }), "Using the shared Jira connection.");
              }}
            >
              <label className="text-xs">
                Or use the shared connection (read-only) — your Jira accountId
                <input value={sharedAccountId} onChange={(e) => setSharedAccountId(e.target.value)} required className="mt-0.5 block rounded border border-border bg-surface px-2 py-1 font-mono text-sm" />
              </label>
              <button type="submit" disabled={busy} className="btn btn-sm btn-secondary">
                Use shared
              </button>
            </form>
          )}
        </div>

        <div data-my-slack>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Slack</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {(["none", "personal", "team"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="slack-mode"
                  checked={profile.slack.mode === mode}
                  disabled={busy || (mode === "team" && !options.teamSlackConfigured)}
                  onChange={() => {
                    if (mode !== "personal") void run(() => updateMe({ slack: { mode } }), "Slack setting saved.");
                  }}
                />
                {mode === "none" ? "Off" : mode === "personal" ? "My own webhook" : `Team channel${options.teamSlackLabel ? ` (${options.teamSlackLabel})` : ""}`}
              </label>
            ))}
          </div>
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => updateMe({ slack: { mode: "personal", webhookUrl: webhook } }), "Personal webhook saved.").then(() => setWebhook(""));
            }}
          >
            <label className="text-xs">
              Personal incoming-webhook URL{profile.slack.mode === "personal" && profile.slack.configured ? " (one is saved — paste to replace)" : ""}
              <input type="password" autoComplete="off" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/…" required className="mt-0.5 block w-80 max-w-full rounded border border-border bg-surface px-2 py-1 text-sm" />
            </label>
            <button type="submit" disabled={busy} className="btn btn-sm btn-secondary">
              Save
            </button>
            <button type="button" disabled={busy || !profile.slack.configured} onClick={() => void run(testSlack, "Test message sent.")} className="btn btn-sm btn-secondary">
              Test
            </button>
          </form>
        </div>

        <div data-my-server-features className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">While the app is closed</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={profile.notifyEnabled} disabled={busy} onChange={(e) => void run(() => updateMe({ notifyEnabled: e.target.checked }), "Saved.")} />
            Server notifications — new assignments and mentions to your Slack destination
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={profile.dailySnapshotEnabled} disabled={busy} onChange={(e) => void run(() => updateMe({ dailySnapshotEnabled: e.target.checked }), "Saved.")} />
            Daily snapshot — your standup report is written even on days you don&apos;t open the app
          </label>
          <label className="flex items-center gap-2">
            Timezone (UTC offset, minutes)
            <input
              type="number"
              step={15}
              defaultValue={profile.timezoneOffsetMinutes ?? ""}
              placeholder={String(-new Date().getTimezoneOffset())}
              onBlur={(e) => {
                const v = e.target.value.trim();
                void run(() => updateMe({ timezoneOffsetMinutes: v === "" ? null : Number(v) }), "Timezone saved.");
              }}
              className="w-24 rounded border border-border bg-surface px-2 py-0.5"
            />
          </label>
        </div>
        {status && (
          <p className={status.tone === "ok" ? "text-green" : "text-orange"} role="status">
            {status.text}
          </p>
        )}
      </div>
    </Panel>
  );
}
