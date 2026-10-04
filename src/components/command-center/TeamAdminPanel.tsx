"use client";

// L6 — Data & Settings → Team (admins only): every member (role, Jira connected?, last login,
// Jira-write permission, disabled) and the invite list. The server refuses changes that would
// leave no enabled admin, or demote someone listed in AUTH_ADMIN_EMAILS.

import { useEffect, useState } from "react";
import { addInvite, loadTeam, removeInvite, updateTeamUser, type TeamBody } from "@/lib/command-center/auth/auth-client";
import { useAuthSession } from "./AuthGate";
import { Panel, SectionHeading } from "./ui";

export function TeamAdminPanel() {
  const session = useAuthSession();
  const isAdmin = session?.me.user.role === "admin";
  const [team, setTeam] = useState<TeamBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteDraft, setInviteDraft] = useState("");
  useEffect(() => {
    if (!isAdmin) return;
    void loadTeam().then((r) => (r.ok ? setTeam(r.data) : setError(r.error)));
  }, [isAdmin]);
  if (!isAdmin) return null;

  const apply = async (p: Promise<{ ok: true; data: TeamBody } | { ok: false; error: string }>) => {
    const r = await p;
    if (r.ok) {
      setTeam(r.data);
      setError(null);
    } else setError(r.error);
  };
  const me = session!.me.user.uid;

  return (
    <Panel className="p-5" data-team-admin>
      <SectionHeading title="Team" subtitle="Who can sign in, and what they may do. Each member's data is separate — admins can't see it either." />
      <div className="space-y-4 text-sm text-text2">
        {error && <p className="text-orange" role="alert">{error}</p>}
        {!team ? (
          <p>Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text3">
                <tr>
                  <th className="py-1 pr-3">Member</th>
                  <th className="py-1 pr-3">Role</th>
                  <th className="py-1 pr-3">Jira</th>
                  <th className="py-1 pr-3">Last login</th>
                  <th className="py-1 pr-3">May write to Jira</th>
                  <th className="py-1">Disabled</th>
                </tr>
              </thead>
              <tbody>
                {team.users.map((u) => (
                  <tr key={u.uid} className="border-t border-border" data-team-user={u.email}>
                    <td className="py-1 pr-3 text-text">
                      {u.name ? `${u.name} · ` : ""}
                      {u.email}
                      {u.uid === me ? " (you)" : ""}
                    </td>
                    <td className="py-1 pr-3">
                      <select value={u.role} disabled={u.envAdmin} onChange={(e) => void apply(updateTeamUser(u.uid, { role: e.target.value as "admin" | "member" }))} aria-label={`Role of ${u.email}`} className="rounded border border-border bg-surface px-1">
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      {u.envAdmin && <span className="ml-1 text-text3">(AUTH_ADMIN_EMAILS)</span>}
                    </td>
                    <td className="py-1 pr-3">{u.jiraConnected ? (u.jiraMode === "shared" ? "shared" : "connected") : "—"}</td>
                    <td className="py-1 pr-3">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                    <td className="py-1 pr-3">
                      <input type="checkbox" checked={u.canWriteJira} onChange={(e) => void apply(updateTeamUser(u.uid, { canWriteJira: e.target.checked }))} aria-label={`${u.email} may write to Jira`} />
                    </td>
                    <td className="py-1">
                      <input type="checkbox" checked={u.disabled} disabled={u.envAdmin} onChange={(e) => void apply(updateTeamUser(u.uid, { disabled: e.target.checked }))} aria-label={`${u.email} disabled`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {team && (
          <div data-team-invites>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Invites</p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {team.invites.length === 0 && <li className="text-text3">None.</li>}
              {team.invites.map((email) => (
                <li key={email} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs">
                  {email}
                  <button onClick={() => void apply(removeInvite(email))} aria-label={`Remove invite for ${email}`} className="text-text3 hover:text-text">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void apply(addInvite(inviteDraft)).then(() => setInviteDraft(""));
              }}
            >
              <input type="email" value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)} placeholder="name@company.com" required aria-label="Email to invite" className="rounded border border-border bg-surface px-2 py-1 text-sm" />
              <button type="submit" className="btn btn-sm btn-secondary">
                Invite
              </button>
            </form>
          </div>
        )}
      </div>
    </Panel>
  );
}
