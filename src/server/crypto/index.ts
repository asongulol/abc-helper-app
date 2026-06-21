import 'server-only';
import { decryptField, encryptField, isEnvelope } from '@/lib/crypto/envelope';
import { createLocalKeyProvider } from '@/lib/crypto/local-provider';
import type { KeyProvider } from '@/lib/crypto/types';
import { env } from '@/server/env';
import { createAwsKmsProvider } from './aws-kms-provider';

export type { KeyProvider } from '@/lib/crypto/types';
export { decryptField, encryptField, isEnvelope };

let cached: KeyProvider | null = null;

/**
 * Resolve the configured envelope key provider (memoized). 'local' reads a
 * base64 32-byte master key from PHI_LOCAL_MASTER_KEY; 'aws' uses PHI_KMS_KEY_ID.
 * Fails loudly when the selected provider is misconfigured — PHI must never be
 * encrypted under a silently-wrong or default key.
 */
export const getKeyProvider = (): KeyProvider => {
  if (cached) return cached;

  if (env.PHI_KMS_PROVIDER === 'aws') {
    if (!env.PHI_KMS_KEY_ID)
      throw new Error('PHI_KMS_KEY_ID is required when PHI_KMS_PROVIDER=aws');
    cached = createAwsKmsProvider({ keyId: env.PHI_KMS_KEY_ID });
    return cached;
  }

  const b64 = env.PHI_LOCAL_MASTER_KEY;
  if (!b64) {
    throw new Error(
      'PHI_LOCAL_MASTER_KEY is not set — generate one with ' +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`",
    );
  }
  cached = createLocalKeyProvider(Buffer.from(b64, 'base64'));
  return cached;
};

/**
 * Key-gated column-encryption seam. Until a provider is configured these are
 * no-ops (values stay plaintext) — so wiring them into a write/read path changes
 * NOTHING until ops sets PHI_LOCAL_MASTER_KEY (or KMS). Reads detect ciphertext
 * by its envelope prefix, so plaintext and encrypted rows coexist during backfill.
 */
export const isPhiEncryptionConfigured = (): boolean =>
  env.PHI_KMS_PROVIDER === 'aws' || !!env.PHI_LOCAL_MASTER_KEY;

/** Encrypt for storage when configured; otherwise return the plaintext unchanged. */
export const encryptIfConfigured = async (plaintext: string): Promise<string> =>
  isPhiEncryptionConfigured() ? encryptField(getKeyProvider(), plaintext) : plaintext;

/** Decrypt only values that are envelope tokens; legacy plaintext passes through. */
export const decryptIfNeeded = async (value: string): Promise<string> =>
  isEnvelope(value) ? decryptField(getKeyProvider(), value) : value;
