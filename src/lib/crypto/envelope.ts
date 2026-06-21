/**
 * App-layer envelope encryption for PHI/PII column values (AES-256-GCM).
 *
 * Pure with respect to the environment — the master key never appears here; a
 * KeyProvider supplies/​wraps the per-value data key. That keeps this module
 * trivially testable and identical across local-dev and KMS deployments.
 *
 * Token format (self-describing, versioned, dot-joined base64url):
 *   phi.v1.<wrappedDEK>.<iv>.<authTag>.<ciphertext>
 * The `phi.v1.` prefix lets reads distinguish ciphertext from legacy plaintext
 * during/after a backfill (see isEnvelope).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './types';

const MAGIC = 'phi.v1';
const b64u = (b: Buffer): string => b.toString('base64url');
const ub64 = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Encrypt a UTF-8 string into a self-describing envelope token. */
export const encryptField = async (provider: KeyProvider, plaintext: string): Promise<string> => {
  const { plaintext: dek, wrapped } = await provider.generateDataKey();
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [MAGIC, b64u(wrapped), b64u(iv), b64u(tag), b64u(ct)].join('.');
  } finally {
    dek.fill(0); // best-effort wipe of the plaintext data key
  }
};

/** Decrypt an envelope token back to its UTF-8 plaintext. Throws on tamper/format. */
export const decryptField = async (provider: KeyProvider, token: string): Promise<string> => {
  const parts = token.split('.');
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== MAGIC) {
    throw new Error('not a PHI envelope token');
  }
  const [, , w, iv, tag, ct] = parts;
  const dek = await provider.unwrap(ub64(w as string));
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, ub64(iv as string));
    decipher.setAuthTag(ub64(tag as string));
    return Buffer.concat([decipher.update(ub64(ct as string)), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
};

/** True when a stored value is an envelope token (vs legacy plaintext). */
export const isEnvelope = (value: string): boolean => value.startsWith(`${MAGIC}.`);
