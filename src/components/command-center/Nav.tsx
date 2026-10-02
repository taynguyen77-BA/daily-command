"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { commandCenterStore } from "@/lib/command-center/store";
import { initAppStateSync } from "@/lib/command-center/app-state-sync";
import { initAutoJiraSync } from "@/lib/command-center/auto-sync";
import { initAutoDailyReport } from "@/lib/command-center/auto-daily-report";
import { initFollowUpReminders } from "@/lib/command-center/follow-up-runner";
import { shouldRunMorningBrief } from "@/lib/command-center/morning-brief";
import { MORNING_MODE_LANDING, shouldOpenMorningMode } from "@/lib/command-center/morning-mode";
import { getTodayIso } from "@/lib/command-center/store";

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
// C2 — grouped for the morning workflow (every route kept; only the order/grouping changed):
// start the day (TODAY), work the queues, look into projects, report out, configure.
interface NavGroup {
  label: string;
  links: NavLink[];
}
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Today",
    links: [
      // One entry for every ticket that is mine — Today / New / In progress / Blocked /
      // Skipped-Deferred / Done. Absorbs Daily Review (/daily-review → New) and My Day
      // (/focus → Today); both old routes still work and redirect there.
      { href: "/my-work", label: "My Work" },
      { href: "/", label: "Command Center" },
    ],
  },
  {
    label: "Work queues",
    links: [
      { href: "/priorities", label: "Priorities" },
      { href: "/action-plan", label: "Action Plan" },
      { href: "/attention", label: "Attention Queue" },
    ],
  },
  {
    label: "Project insight",
    links: [
      { href: "/risks", label: "Risks" },
      { href: "/dependencies", label: "Dependencies" },
      { href: "/changes", label: "Changes" },
      { href: "/loops", label: "Delivery Loops", advanced: true },
      { href: "/decisions", label: "Decision Log", advanced: true },
      { href: "/meeting", label: "Meeting Mode" },
    ],
  },
  {
    label: "Reports",
    links: [
      { href: "/reports", label: "Reports" },
      { href: "/weekly-review", label: "Weekly Review" },
    ],
  },
  { label: "Settings", links: [{ href: "/data-settings", label: "Data & Settings" }] },
];
const LINKS: NavLink[] = NAV_GROUPS.flatMap((g) => g.links);

/** My Work's badge: unreviewed New + re-checks due today (store.computeMyWorkBadge — the same
 *  partition the page shows). Recomputed only when the store state object changes. */
function useMyWorkBadge(): number {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  return useMemo(() => (state.loaded ? commandCenterStore.computeMyWorkBadge() : 0), [state]);
}

/** D1 — Morning Brief one-click: the first time the app is opened on a day (feature on), it
 *  syncs Jira (when connected) and lands on My Work → New, whose header then summarizes what
 *  happened since yesterday 18:00. Runs once per day, only when entered at "/". */
let morningBriefRedirected = false;
const MORNING_BRIEF_LANDING = "/my-work?view=new";
function useMorningBrief(pathname: string | null): boolean {
  const router = useRouter();
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const ran = useRef(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (ran.current || !state.loaded) return;
    ran.current = true;
    const today = getTodayIso();
    // F1 — Morning Mode takes over the first open of the day (it runs the sync itself, with
    // progress) until today's triage is done; otherwise D1's one-click brief as before.
    const morning = shouldOpenMorningMode({ enabled: state.features.morningMode, loaded: state.loaded, today, morningTriage: state.morningTriage });
    if (!shouldRunMorningBrief(state.features.morningBrief || morning, state.morningBriefLastRunDay, today) || pathname !== "/") return;
    setActive(true);
    morningBriefRedirected = true; // the landing-page redirect below must not override this
    commandCenterStore.recordMorningBriefRun(today);
    if (morning) {
      router.replace(MORNING_MODE_LANDING);
      return;
    }
    if (state.dataSource === "jira" && state.jiraSync.lastSyncStatus !== "never") void commandCenterStore.syncJira({ trigger: "auto" });
    router.replace(MORNING_BRIEF_LANDING);
  }, [state, pathname, router]);
  return active;
}

/** C2 — opens the configured landing page once per browser session, only when the app was
 *  entered at "/" (clicking "Command Center" later always goes to "/"). */
function useLandingRedirect(pathname: string | null) {
  const router = useRouter();
  const landing = useSyncExternalStore(
    commandCenterStore.subscribe,
    () => commandCenterStore.getSnapshot().defaultLandingPage,
    () => undefined
  );
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !landing) return;
    checked.current = true;
    let alreadyRedirected = false;
    try {
      alreadyRedirected = window.sessionStorage.getItem("command-center:landed") === "1";
      window.sessionStorage.setItem("command-center:landed", "1");
    } catch {
      // storage unavailable — redirect at most once per page load instead
    }
    if (!alreadyRedirected && !morningBriefRedirected && pathname === "/" && landing !== "/") router.replace(landing);
  }, [landing, pathname, router]);
}

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
      <Link href="/data-settings" className="btn btn-sm btn-ghost">
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
      className="btn btn-sm btn-secondary"
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
  const myWorkBadge = useMyWorkBadge();
  const morningBriefActive = useMorningBrief(pathname);
  useLandingRedirect(morningBriefActive ? "/my-work" : pathname);
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

  // D5 — Slack follow-up reminders for blocked tickets whose "ping on" date has come.
  useEffect(() => {
    initFollowUpReminders(commandCenterStore);
  }, []);

  return (
    <nav className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      {/* V2.9 §F-04 fix — below md, 14 flat links plus the filter bar used to fill an
          entire mobile screen before any real content appeared, and long link labels
          overflowed the viewport width. Collapsed behind a toggle showing the current
          page; the full flat flex-wrap layout is unchanged at md and above. */}
      <div className="mx-auto flex w-full max-w-shell items-center justify-between gap-2 px-4 py-2.5 sm:px-6 md:hidden">
        <span className="text-sm font-medium text-text">{activeLink.label}</span>
        <div className="flex items-center gap-2">
          <SyncJiraHeaderButton />
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="mobile-nav-links"
            aria-label={open ? "Close navigation menu" : "Open navigation menu"}
            className="btn btn-sm btn-secondary"
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
        className={`${open ? "flex" : "hidden"} mx-auto w-full max-w-shell flex-col gap-0.5 px-4 pb-3 sm:px-6 md:flex md:flex-row md:flex-wrap md:items-center md:gap-x-1 md:gap-y-1 md:py-1.5`}
      >
        {NAV_GROUPS.map((group, groupIndex) => {
          const groupLinks = group.links.filter((link) => !link.advanced || showAdvanced);
          if (groupLinks.length === 0) return null;
          return (
            <div key={group.label} data-nav-group={group.label} className="flex flex-col gap-0.5 md:flex-row md:items-center md:gap-0.5">
              {/* Group names label the mobile menu; on desktop the dividers between groups carry
                  the grouping (names come back on very wide screens) so the bar stays one row. */}
              <span className="eyebrow px-3 pt-3 md:hidden 2xl:block 2xl:px-1.5 2xl:pt-0">{group.label}</span>
              {groupLinks.map((link) => {
                const active = link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href);
                const badge = link.href === "/my-work" ? myWorkBadge : 0;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors md:px-2.5 ${
                      active ? "bg-surface2 text-text" : "text-text3 hover:bg-surface2/60 hover:text-text"
                    }`}
                  >
                    {link.label}
                    {badge > 0 && (
                      <span data-nav-badge title="Unreviewed New tickets + re-checks due today" className="tabular rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-4 text-white">
                        {badge}
                      </span>
                    )}
                  </Link>
                );
              })}
              {groupIndex < NAV_GROUPS.length - 1 && <span aria-hidden="true" className="hidden h-4 w-px bg-border2 md:mx-1.5 md:block" />}
            </div>
          );
        })}
        <div className="hidden md:ml-auto md:block">
          <SyncJiraHeaderButton />
        </div>
      </div>
    </nav>
  );
}
