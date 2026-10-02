// G4 — optional passphrase protection for backup files. A backup holds client ticket data
// (titles, people, reports, history); with a passphrase it is encrypted with AES-GCM (256-bit)
// under a key derived by PBKDF2-SHA-256 (≥ 200,000 iterations) from the passphrase, with a
// random salt and IV stored in the file header. Uses WebCrypto only (the browser's
// crypto.subtle, also available in Node for the tests) — no dependency, nothing leaves the
// device. Without a passphrase, export is the plain JSON file as before.

export const ENCRYPTED_BACKUP_FORMAT = "ba-po-pm-command-center/backup-encrypted";
export const BACKUP_PBKDF2_ITERATIONS = 250_000;
const MIN_ITERATIONS = 200_000;
const MAX_ITERATIONS = 5_000_000; // refuse absurd values from a tampered header

export interface EncryptedBackupFile {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  /** base64 ciphertext (with the GCM tag) of the plain backup JSON. */
  data: string;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("This browser can't encrypt (WebCrypto unavailable).");
  return c.subtle;
}

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptBackupText(plain: string, passphrase: string, iterations: number = BACKUP_PBKDF2_ITERATIONS): Promise<string> {
  if (!passphrase) throw new Error("A passphrase is required to encrypt.");
  if (iterations < MIN_ITERATIONS) throw new Error(`At least ${MIN_ITERATIONS} PBKDF2 iterations.`);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plain)));
  const file: EncryptedBackupFile = {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toB64(salt) },
    cipher: { name: "AES-GCM", iv: toB64(iv) },
    data: toB64(data),
  };
  return JSON.stringify(file, null, 2);
}

/** Whether `raw` is an encrypted backup (cheap check; no decryption). */
export function isEncryptedBackup(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { format?: unknown })?.format === ENCRYPTED_BACKUP_FORMAT;
  } catch {
    return false;
  }
}

export async function decryptBackupText(raw: string, passphrase: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let file: Partial<EncryptedBackupFile>;
  try {
    file = JSON.parse(raw) as Partial<EncryptedBackupFile>;
  } catch {
    return { ok: false, error: "This file isn't valid JSON. Nothing was imported." };
  }
  const it = file.kdf?.iterations;
  if (file.format !== ENCRYPTED_BACKUP_FORMAT || file.version !== 1 || file.kdf?.name !== "PBKDF2" || file.cipher?.name !== "AES-GCM" || typeof it !== "number" || it < MIN_ITERATIONS || it > MAX_ITERATIONS || !file.kdf.salt || !file.cipher.iv || !file.data) {
    return { ok: false, error: "This encrypted backup's header is damaged or from an unknown version. Nothing was imported." };
  }
  if (!passphrase) return { ok: false, error: "Enter the passphrase this backup was exported with." };
  try {
    const key = await deriveKey(passphrase, fromB64(file.kdf.salt), it);
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(file.cipher.iv) as BufferSource }, key, fromB64(file.data) as BufferSource);
    return { ok: true, text: new TextDecoder().decode(plain) };
  } catch {
    // AES-GCM authenticates: a wrong passphrase and a tampered file both fail here.
    return { ok: false, error: "Wrong passphrase (or the file was altered). Nothing was imported." };
  }
}
