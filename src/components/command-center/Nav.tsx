"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { commandCenterStore } from "@/lib/command-center/store";
import { initAppStateSync } from "@/lib/command-center/app-state-sync";
import { initAutoJiraSync } from "@/lib/command-center/auto-sync";
import { initAutoDailyReport } from "@/lib/command-center/auto-daily-report";

interface NavLink {
  href: string;
  label: string;
  // V2.13 §2 — hidden from primary nav by default, behind the "Show advanced/rarely-used
  // sections" toggle (Data & Settings, V2.11 §3B). The route itself is untouched and stays
  // fully reachable by direct URL/bookmark either way — this only affects whether the link
  // is listed here.
  advanced?: boolean;
}

// V2.13 §2 — Delivery Loops and Decision Log depend entirely on manually-logged Decisions
// (store.addDecision); with no automatic Jira-derived path into that model, an installation
// that has never logged a decision sees these as correctly-coded but perpetually empty. Not
// deleted, not broken — just hidden from the default nav until the user opts in.
// Project Memory (`/memory`) is a different case (auto-populated by real system activity) and
// is intentionally not in this list at all — see data-settings/page.tsx's Activity Log section.
const LINKS: NavLink[] = [
  { href: "/", label: "Command Center" },
  { href: "/focus", label: "My Day" },
  // V2.26 — the morning check over new / skipped / blocked / completed tickets.
  { href: "/daily-review", label: "Daily Review" },
  { href: "/meeting", label: "Meeting Mode" },
  { href: "/attention", label: "Attention Queue" },
  { href: "/loops", label: "Delivery Loops", advanced: true },
  { href: "/priorities", label: "Priorities" },
  { href: "/changes", label: "Changes" },
  { href: "/risks", label: "Risks" },
  { href: "/dependencies", label: "Dependencies" },
  { href: "/action-plan", label: "Action Plan" },
  { href: "/decisions", label: "Decision Log", advanced: true },
  { href: "/weekly-review", label: "Weekly Review" },
  { href: "/data-settings", label: "Data & Settings" },
];

// V2.24 follow-up — a header shortcut for the exact same incremental sync data-settings/
// page.tsx's "Sync Jira" button already calls (store.syncJira({ full: false })): zero
// duplicated sync logic, same read-only guarantee. Deliberately never available until
// lastSyncStatus is no longer "never" — the first-ever contact with a real Jira instance
// stays gated behind Data & Settings' explicit read-only confirmation dialog (V2.1 §8);
// this shortcut only ever keeps an already-consented connection fresh, same boundary
// auto-sync.ts's shouldAutoSyncJira already enforces for the automatic path.
function SyncJiraHeaderButton() {
  const dataSource = useSyncExternalStore(
    commandCenterStore.subscribe,
    () => commandCenterStore.getSnapshot().dataSource,
    () => commandCenterStore.getServerSnapshot().dataSource
  );
  const jiraSync = useSyncExternalStore(
    commandCenterStore.subscribe,
    () => commandCenterStore.getSnapshot().jiraSync,
    () => commandCenterStore.getServerSnapshot().jiraSync
  );
  // The store owns the real in-progress state (syncJira() refuses overlapping calls itself);
  // local `syncing` only drives this button's own spinner/result label.
  const syncActivity = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getJiraSyncActivity, commandCenterStore.getServerJiraSyncActivity);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<"ok" | "error" | "busy" | null>(null);
  const resultTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resultTimeout.current) clearTimeout(resultTimeout.current);
  }, []);

  if (dataSource !== "jira") return null;

  if (jiraSync.lastSyncStatus === "never") {
    return (
      <Link href="/data-settings" className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text3 hover:text-text2">
        Connect Jira
      </Link>
    );
  }

  const syncingElsewhere = syncActivity.inProgress && !syncing;

  async function handleClick() {
    if (syncing || syncActivity.inProgress) return;
    setSyncing(true);
    setResult(null);
    const outcome = await commandCenterStore.syncJira({ full: false, trigger: "header" });
    setSyncing(false);
    setResult(outcome.ok ? "ok" : outcome.errorKind === "sync-in-progress" ? "busy" : "error");
    if (resultTimeout.current) clearTimeout(resultTimeout.current);
    resultTimeout.current = setTimeout(() => setResult(null), 4000);
  }

  const lastSyncedLabel = jiraSync.lastSyncCompletedAt ? new Date(jiraSync.lastSyncCompletedAt).toLocaleTimeString() : "never";

  return (
    <button
      onClick={handleClick}
      disabled={syncing || syncingElsewhere}
      title={`Last synced: ${lastSyncedLabel}`}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text2 hover:border-accent hover:text-text disabled:opacity-60"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={syncing || syncingElsewhere ? "animate-spin" : undefined}>
        <path
          d="M10.5 6a4.5 4.5 0 1 1-1.318-3.182M10.5 1.5v3h-3"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {syncing
        ? "Syncing…"
        : syncingElsewhere
          ? "Syncing… (started elsewhere)"
          : result === "ok"
            ? "Synced"
            : result === "busy"
              ? "Sync already running in another tab"
              : result === "error"
                ? "Sync failed"
                : "Sync Jira"}
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const showAdvanced = useSyncExternalStore(
    commandCenterStore.subscribe,
    () => commandCenterStore.getSnapshot().showAdvancedSettings,
    () => commandCenterStore.getServerSnapshot().showAdvancedSettings
  );
  const links = LINKS.filter((link) => !link.advanced || showAdvanced);
  const activeLink = links.find((link) => (link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href))) ?? links[0];

  // V2.15 §3 point 1 — Nav is mounted exactly once, app-wide, by the root layout (persists
  // across client-side navigations), making it the natural single init point for Cross-Device
  // Sync — never blocks first paint (fire-and-forget; render already happened from local
  // state before this effect even runs). initAppStateSync is itself idempotent (a module-level
  // guard), so this being technically re-runnable (e.g. React StrictMode's dev double-invoke)
  // is harmless.
  useEffect(() => {
    void initAppStateSync(commandCenterStore);
  }, []);

  // V2.24 — same single-init-point reasoning as above, for automatic Jira sync: this is the
  // one place already guaranteed to mount exactly once app-wide, so it's the natural place to
  // start the background freshness check too. initAutoJiraSync is itself idempotent (a
  // module-level guard, same pattern as initAppStateSync), so a StrictMode dev double-invoke
  // is equally harmless here.
  useEffect(() => {
    initAutoJiraSync(commandCenterStore);
  }, []);

  // V2.25 Task 2 — same single-init-point reasoning as above: ensures today's Daily Report
  // exists (Demo/Local Import installs, or a Jira install whose data is still "fresh" enough
  // that initAutoJiraSync's own tick is a no-op) without requiring the user to open Close Day.
  // A real Jira sync's own completion also triggers this (see store.ts's syncJira), so this
  // on-load check is specifically the safety net for the paths that never sync at all.
  useEffect(() => {
    initAutoDailyReport(commandCenterStore);
  }, []);

  return (
    <nav className="border-b border-border">
      {/* V2.9 §F-04 fix — below md, 14 flat links plus the filter bar used to fill an
          entire mobile screen before any real content appeared, and long link labels
          overflowed the viewport width. Collapsed behind a toggle showing the current
          page; the full flat flex-wrap layout is unchanged at md and above. */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 md:hidden">
        <span className="text-sm font-medium text-text">{activeLink.label}</span>
        <div className="flex items-center gap-2">
          <SyncJiraHeaderButton />
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-nav-links"
            aria-label={open ? "Close navigation menu" : "Open navigation menu"}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text2"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              {open ? (
                <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M1 3.5H13M1 7H13M1 10.5H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </svg>
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      <div
        id="mobile-nav-links"
        className={`${open ? "flex" : "hidden"} flex-col gap-0.5 px-4 pb-3 md:flex md:flex-row md:flex-wrap md:items-center md:gap-1 md:px-6 md:py-2 md:pb-2`}
      >
        {links.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-surface2 text-text" : "text-text3 hover:text-text2"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
        <div className="hidden md:ml-auto md:block">
          <SyncJiraHeaderButton />
        </div>
      </div>
    </nav>
  );
}
