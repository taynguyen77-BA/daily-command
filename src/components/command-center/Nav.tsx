"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Command Center" },
  { href: "/focus", label: "My Day" },
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
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border px-6 py-2">
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-surface2 text-text" : "text-text3 hover:text-text2"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
