"use client";

// L6 — one button per configured provider, and the email-only dev login (never in production).

import { useState } from "react";
import { signIn } from "next-auth/react";
import type { AuthProviders } from "@/lib/command-center/auth/auth-config";

const LABEL: Record<"google" | "azure-ad" | "atlassian", string> = { google: "Continue with Google", "azure-ad": "Continue with Microsoft", atlassian: "Continue with Atlassian" };

export function SignInButtons({ providers, callbackUrl }: { providers: AuthProviders; callbackUrl: string }) {
  const [email, setEmail] = useState("");
  const ids = [providers.google && "google", providers.azureAd && "azure-ad", providers.atlassian && "atlassian"].filter(Boolean) as (keyof typeof LABEL)[];
  return (
    <div className="mt-4 space-y-2">
      {ids.map((id) => (
        <button key={id} onClick={() => void signIn(id, { callbackUrl })} className="btn btn-secondary w-full" data-signin-provider={id}>
          {LABEL[id]}
        </button>
      ))}
      {providers.dev && (
        <form
          className="mt-3 space-y-1 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void signIn("dev-login", { email: email.trim(), callbackUrl });
          }}
        >
          <label className="block text-xs text-text3">
            Dev login (AUTH_DEV_LOGIN — never in production): email only
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 text-text" />
          </label>
          <button type="submit" className="btn btn-primary w-full">
            Sign in
          </button>
        </form>
      )}
    </div>
  );
}
