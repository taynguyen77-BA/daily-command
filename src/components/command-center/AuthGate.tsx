"use client";

// L5 — team sign-in only (the root layout mounts this only when AUTH_ENABLED=true). Before
// anything reads the store, it loads the signed-in member (/api/command-center/me), switches
// requests to the session cookie (no pairing headers), and points the store at that member's
// own device key — so nothing renders until whose data it is is settled. It then keeps the
// app's identity in step with the member's verified Jira account.

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { commandCenterStore } from "@/lib/command-center/store";
import { setSessionAuthMode } from "@/lib/command-center/device-pairing";
import { identityFromMe, loadMe, type Me } from "@/lib/command-center/auth/auth-client";
import { authMisconfiguredText } from "./SetupHealthBanner";

interface AuthSession {
  me: Me;
  setMe: (me: Me) => void;
}

const AuthContext = createContext<AuthSession | null>(null);

/** The signed-in member, or null with sign-in off. */
export function useAuthSession(): AuthSession | null {
  return useContext(AuthContext);
}

type Phase = { kind: "loading" } | { kind: "ready"; me: Me } | { kind: "message"; title: string; text: string; missing?: string[] };

export function AuthGate({ shell, children }: { shell: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  const onSignIn = pathname?.startsWith("/signin") ?? false;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (onSignIn) return;
    let cancelled = false;
    void loadMe().then((r) => {
      if (cancelled) return;
      if (r.kind === "signed-in") {
        setSessionAuthMode(true);
        if (!commandCenterStore.setUserNamespace(r.me.user.uid, { adoptLegacy: r.me.adoptLegacyData })) {
          // The store was read before the member was known — reload so it opens the right data.
          window.location.reload();
          return;
        }
        setPhase({ kind: "ready", me: r.me });
      } else if (r.kind === "signed-out") {
        window.location.href = `/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      } else if (r.kind === "misconfigured") {
        setPhase({ kind: "message", title: "Setup Health — sign-in isn't fully configured", text: authMisconfiguredText(r.missing), missing: r.missing });
      } else if (r.kind === "off") {
        setPhase({ kind: "message", title: "Sign-in is off on the server", text: "This build expects sign-in, but the server has AUTH_ENABLED unset — redeploy after changing it." });
      } else {
        setPhase({ kind: "message", title: "Couldn't load your account", text: r.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onSignIn]);

  // Keep the app's identity (mentions, assignments, reports) on the member's verified Jira account.
  const me = phase.kind === "ready" ? phase.me : null;
  useEffect(() => {
    if (!me) return;
    const sync = () => {
      const next = identityFromMe(commandCenterStore.getSnapshot().personalIdentity, me);
      if (next) commandCenterStore.setPersonalIdentity(next);
    };
    sync();
    const unsubscribe = commandCenterStore.subscribe(sync);
    return () => {
      unsubscribe();
    };
  }, [me]);

  if (onSignIn) return <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 md:py-8">{children}</main>;
  if (phase.kind === "loading") return <p className="p-8 text-sm text-text3">Loading your workspace…</p>;
  if (phase.kind === "message") {
    return (
      <div className="mx-auto max-w-xl p-8 text-sm text-text2" role="alert" data-auth-gate-error>
        <p className="font-semibold text-text">{phase.title}</p>
        <p className="mt-1">{phase.text}</p>
        {phase.missing && phase.missing.length > 0 && (
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {phase.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <AuthContext.Provider value={{ me: phase.me, setMe: (next) => setPhase({ kind: "ready", me: next }) }}>
      {shell}
      <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 md:py-8">{children}</main>
    </AuthContext.Provider>
  );
}
