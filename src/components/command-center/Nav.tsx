"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { commandCenterStore } from "@/lib/command-center/store";
import { initAppStateSync } from "@/lib/command-center/app-state-sync";
import { initAutoJiraSync } from "@/lib/command-center/auto-sync";

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

  return (
    <nav className="border-b border-border">
      {/* V2.9 §F-04 fix — below md, 14 flat links plus the filter bar used to fill an
          entire mobile screen before any real content appeared, and long link labels
          overflowed the viewport width. Collapsed behind a toggle showing the current
          page; the full flat flex-wrap layout is unchanged at md and above. */}
      <div className="flex items-center justify-between px-4 py-2.5 md:hidden">
        <span className="text-sm font-medium text-text">{activeLink.label}</span>
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
      <div
        id="mobile-nav-links"
        className={`${open ? "flex" : "hidden"} flex-col gap-0.5 px-4 pb-3 md:flex md:flex-row md:flex-wrap md:gap-1 md:px-6 md:py-2 md:pb-2`}
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
      </div>
    </nav>
  );
}
