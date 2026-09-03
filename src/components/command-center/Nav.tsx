"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Command Center" },
  { href: "/focus", label: "My Day" },
  { href: "/meeting", label: "Meeting Mode" },
  { href: "/attention", label: "Attention Queue" },
  { href: "/loops", label: "Delivery Loops" },
  { href: "/priorities", label: "Priorities" },
  { href: "/changes", label: "Changes" },
  { href: "/risks", label: "Risks" },
  { href: "/dependencies", label: "Dependencies" },
  { href: "/action-plan", label: "Action Plan" },
  { href: "/decisions", label: "Decision Log" },
  { href: "/memory", label: "Project Memory" },
  { href: "/weekly-review", label: "Weekly Review" },
  { href: "/data-settings", label: "Data & Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const activeLink = LINKS.find((link) => (link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href))) ?? LINKS[0];

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
        {LINKS.map((link) => {
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
