// L6 — the sign-in page: the providers this server has configured (plus the dev login outside
// production), a clear message when an email isn't allowed or the account is disabled, and the
// exact missing variables when sign-in is switched on but not fully configured.

import { readAuthSettings } from "@/lib/command-center/auth/auth-config";
import { SignInButtons } from "@/components/command-center/SignInButtons";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  AccessDenied: "This email isn't allowed to sign in. Ask an admin to invite you (or to add your email or domain).",
  Disabled: "This account has been disabled. Ask an admin.",
  OAuthAccountNotLinked: "Sign in with the same provider you used before.",
};

export default async function SignInPage(props: { searchParams: Promise<{ error?: string; callbackUrl?: string }> }) {
  // Next 16 — searchParams is a Promise.
  const searchParams = await props.searchParams;
  const settings = readAuthSettings(process.env);
  const callbackUrl = searchParams.callbackUrl?.startsWith("/") && !searchParams.callbackUrl.startsWith("//") ? searchParams.callbackUrl : "/";
  const error = searchParams.error ? (ERRORS[searchParams.error] ?? "Sign-in failed. Try again, or ask an admin.") : null;
  return (
    <div className="mx-auto mt-12 max-w-sm rounded-md border border-border bg-surface p-6 text-sm text-text2" data-signin>
      <h1 className="text-lg font-semibold text-text">Sign in to Daily Command</h1>
      {!settings.enabled ? (
        <p className="mt-2">Sign-in isn&apos;t enabled on this server — the app is open on this device.</p>
      ) : settings.missing.length > 0 ? (
        <div className="mt-2" role="alert" data-signin-misconfigured>
          <p className="text-orange">Sign-in is switched on but not fully configured. The server needs:</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {settings.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {error && (
            <p className="mt-2 rounded border border-orange/40 bg-orange/10 p-2 text-orange" role="alert" data-signin-error>
              {error}
            </p>
          )}
          <SignInButtons providers={settings.providers} callbackUrl={callbackUrl} />
        </>
      )}
    </div>
  );
}
