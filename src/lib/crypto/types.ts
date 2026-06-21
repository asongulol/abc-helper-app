/**
 * Envelope-encryption key provider — the KMS-agnostic seam.
 *
 * Data is never encrypted directly with the master key (KEK). Instead a fresh
 * random data key (DEK) encrypts each value, and the DEK is wrapped by the KEK.
 * This is exactly AWS KMS's GenerateDataKey/Decrypt model, so swapping the
 * local dev provider for a real KMS is a single adapter — the stored envelope
 * format (src/lib/crypto/envelope.ts) is unchanged.
 */
export interface KeyProvider {
  /** A fresh data key: `plaintext` for local AES use, `wrapped` to store alongside the ciphertext. */
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  /** Unwrap a stored wrapped DEK back to its plaintext bytes. */
  unwrap(wrapped: Buffer): Promise<Buffer>;
}
