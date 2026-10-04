"use client";

// L6 — who is signed in (name, email, role) and Sign out. Renders nothing with sign-in off.

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useAuthSession } from "./AuthGate";

export function UserMenu() {
  const session = useAuthSession();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const { user } = session.me;
  return (
    <div className="relative" data-user-menu>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] text-text2 hover:text-text">
        {user.name || user.email}
      </button>
      {/* z-40: above the sticky Nav (z-30), below dialogs (z-50). */}
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-md border border-border bg-surface p-3 text-xs text-text2 shadow-lg">
          <p className="font-semibold text-text">{user.name || user.email}</p>
          <p className="break-all">{user.email}</p>
          <p className="mt-1 text-text3">Role: {user.role === "admin" ? "Admin" : "Member"}</p>
          <button onClick={() => void signOut({ callbackUrl: "/signin" })} className="btn btn-sm btn-secondary mt-2 w-full">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
