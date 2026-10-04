// L3 — encryption for the per-user secrets kept server-side (a member's Jira API token, a
// personal Slack webhook). AES-256-GCM, format "v1:<iv>:<tag>:<ciphertext>" (base64url). The
// key is AUTH_ENCRYPTION_KEY (32 bytes, base64 or hex) or, when unset, HKDF-SHA-256 from
// NEXTAUTH_SECRET. The user id is bound in as associated data, so a ciphertext copied into
// another user's record does not decrypt. Decryption failures (wrong key, tampering, another
// user's record) return null — never a partial plaintext. Plaintexts never leave the server.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { parseKeyMaterial, type Env } from "./auth-config";

const b64u = (b: Buffer) => b.toString("base64url");

export function resolveEncryptionKey(env: Env): Buffer | null {
  if (env.AUTH_ENCRYPTION_KEY?.trim()) return parseKeyMaterial(env.AUTH_ENCRYPTION_KEY);
  const secret = env.NEXTAUTH_SECRET?.trim();
  if (!secret) return null;
  return Buffer.from(hkdfSync("sha256", secret, "daily-command", "secret-box v1", 32));
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ct)}`;
}

export function decryptSecret(sealed: string | undefined, key: Buffer | null, aad: string): string | null {
  if (!sealed || !key) return null;
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? Buffer.alloc(0) : Buffer.from(p, "base64url")));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
