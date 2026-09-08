// V2.15 §2 — one-time-per-device pairing for Cross-Device Sync. The APP_STATE_SECRET value
// itself must never be a NEXT_PUBLIC_* env var (that would bundle it into every visitor's JS at
// build time) and must never be hardcoded — instead, the user pastes it once into Data &
// Settings' pairing screen, and it's stored ONLY in this device's own localStorage, exactly
// like setting up a password manager or 2FA app per device. Nothing here ever sends the secret
// anywhere except as the Authorization header on this device's own requests to this app's own
// /api/command-center/state and /api/command-center/jira/sync endpoints.

const PAIRING_KEY = "command-center:app-state-secret:v1";

export function getPairedSecret(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PAIRING_KEY);
  } catch {
    return null;
  }
}

export function isDevicePaired(): boolean {
  return !!getPairedSecret();
}

export function setPairedSecret(secret: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PAIRING_KEY, secret);
  } catch {
    // Storage full/unavailable — pairing simply doesn't take on this device this session.
  }
}

export function clearPairedSecret(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PAIRING_KEY);
  } catch {
    // best-effort
  }
}

/** The exact header this device sends on every authenticated sync request, or undefined when
 *  unpaired — callers (jira-source.ts, app-state-sync.ts) spread this into `fetch` headers. */
export function pairedAuthHeader(): { Authorization: string } | undefined {
  const secret = getPairedSecret();
  return secret ? { Authorization: `Bearer ${secret}` } : undefined;
}
