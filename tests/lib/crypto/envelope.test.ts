import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, isEnvelope } from '@/lib/crypto/envelope';
import { createLocalKeyProvider } from '@/lib/crypto/local-provider';

const provider = createLocalKeyProvider(randomBytes(32));

describe('envelope encryption', () => {
  it('round-trips a value', async () => {
    const secret = JSON.stringify({ account: '1234567890', bank: 'BPI' });
    const token = await encryptField(provider, secret);
    expect(isEnvelope(token)).toBe(true);
    expect(token).not.toContain('1234567890');
    expect(await decryptField(provider, token)).toBe(secret);
  });

  it('round-trips a large value (e.g. a signature data-url)', async () => {
    const big = `data:image/png;base64,${randomBytes(50_000).toString('base64')}`;
    const token = await encryptField(provider, big);
    expect(await decryptField(provider, token)).toBe(big);
  });

  it('produces a fresh DEK + IV each time (no deterministic ciphertext)', async () => {
    const a = await encryptField(provider, 'same');
    const b = await encryptField(provider, 'same');
    expect(a).not.toBe(b);
    expect(await decryptField(provider, a)).toBe('same');
    expect(await decryptField(provider, b)).toBe('same');
  });

  it('rejects a tampered ciphertext (GCM auth tag)', async () => {
    const token = await encryptField(provider, 'sensitive');
    const parts = token.split('.');
    const ct = Buffer.from(parts[5] as string, 'base64url');
    ct[0] = ct[0] === undefined ? 0 : ct[0] ^ 0xff; // flip a byte
    parts[5] = ct.toString('base64url');
    await expect(decryptField(provider, parts.join('.'))).rejects.toThrow();
  });

  it('cannot be decrypted with a different master key', async () => {
    const token = await encryptField(provider, 'secret');
    const other = createLocalKeyProvider(randomBytes(32));
    await expect(decryptField(other, token)).rejects.toThrow();
  });

  it('rejects non-envelope input', async () => {
    expect(isEnvelope('plain text')).toBe(false);
    await expect(decryptField(provider, 'plain text')).rejects.toThrow('not a PHI envelope');
  });
});
