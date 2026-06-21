import 'server-only';
import type { KeyProvider } from '@/lib/crypto/types';

/**
 * AWS KMS envelope key provider — INTEGRATION STUB (no KMS is provisioned yet).
 *
 * To wire for production:
 *   1. `pnpm add @aws-sdk/client-kms`
 *   2. set PHI_KMS_PROVIDER=aws and PHI_KMS_KEY_ID=<cmk arn/id>; give the runtime
 *      IAM `kms:GenerateDataKey` + `kms:Decrypt` on that key.
 *   3. implement the two methods below against the SDK:
 *        generateDataKey():
 *          const { Plaintext, CiphertextBlob } =
 *            await kms.send(new GenerateDataKeyCommand({ KeyId, KeySpec: 'AES_256' }));
 *          return { plaintext: Buffer.from(Plaintext), wrapped: Buffer.from(CiphertextBlob) };
 *        unwrap(wrapped):
 *          const { Plaintext } = await kms.send(new DecryptCommand({ CiphertextBlob: wrapped }));
 *          return Buffer.from(Plaintext);
 *
 * The envelope format (src/lib/crypto/envelope.ts) is unchanged, so values
 * written with the local provider remain readable only with that master key —
 * plan a re-encrypt/backfill when switching providers.
 */
export const createAwsKmsProvider = (_config: { keyId: string }): KeyProvider => {
  throw new Error(
    'AWS KMS provider not implemented — install @aws-sdk/client-kms and implement ' +
      'GenerateDataKey/Decrypt (see src/server/crypto/aws-kms-provider.ts).',
  );
};
