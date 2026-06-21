/**
 * Local (dev/test) envelope key provider. The master key (KEK) lives in the app
 * process — NOT a substitute for a real KMS in production, but it exercises the
 * exact same envelope flow so the rest of the system is provider-agnostic.
 *
 * Wrapping uses AES-256-GCM: wrapped = iv(12) ‖ tag(16) ‖ ciphertext(DEK).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './types';

export const createLocalKeyProvider = (masterKey: Buffer): KeyProvider => {
  if (masterKey.length !== 32) {
    throw new Error(`PHI master key must be 32 bytes, got ${masterKey.length}`);
  }
  return {
    async generateDataKey() {
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      const tag = cipher.getAuthTag();
      return { plaintext: dek, wrapped: Buffer.concat([iv, tag, ct]) };
    },
    async unwrap(wrapped: Buffer) {
      const iv = wrapped.subarray(0, 12);
      const tag = wrapped.subarray(12, 28);
      const ct = wrapped.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    },
  };
};
