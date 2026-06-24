---
title: Security & guardrails
sidebar_position: 13
---

# Security & guardrails

The money-moving parts of ABC Helper are protected by a small set of **non-negotiable
invariants** — and most of them are enforced mechanically, not by convention. A build-time
scanner blocks the two patterns that would be catastrophic (funding money, leaking a secret),
the money types make floats unrepresentable, PHI is encrypted at rest behind a KMS-agnostic
seam, and a database guard refuses to push repo migrations to the shared production project.
This page collects those mechanisms in one place.

For the request/auth model see [Architecture](./architecture.md); for the money math see
[Money core spec](./money-core-spec.md).

## The guardrail scanner — `scripts/guardrails.mjs`

A pure-Node, zero-dependency scanner that **fails the build on forbidden source patterns**. It
runs in the **pre-push** hook (lefthook `guardrails` step) and in **CI**, and is also invokable
directly with `pnpm guardrails`.

It walks two roots and lints every JS/TS file it finds:

```js
const ROOTS = ['src', 'supabase/functions'];
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
```

`supabase/functions/` is scanned alongside `src/` deliberately: the `wise-payouts` edge function
reconciles payouts on a schedule, so the draft-only rule (ADR-0007) must hold there too. Each
matching line is checked against every rule; any hit prints `file:line  rule name` plus the
offending line and exits `1`. A clean run prints `✓ Guardrails clean (N files scanned).`

### Rules

| Rule | Pattern (verbatim) | Why |
|---|---|---|
| Wise funding call (money movement must be draft-only — ADR-0007) | <code>/\bfundTransfer\b\|\bfundWithBalance\b\|\.fund\s*\(\|\/transfers\/[^'"\`\n]*\/payments\b/</code> | The app only **stages** transfers; the owner funds them in the Wise UI. No funding helper or funding endpoint may exist in the codebase. See [Wise payouts](./wise.md). |
| Secret exposed via a `NEXT_PUBLIC_` env var | `/NEXT_PUBLIC_[A-Z0-9_]*(SECRET\|SERVICE_ROLE\|SERVICE_KEY\|PRIVATE\|PASSWORD)/` | `NEXT_PUBLIC_*` vars are inlined into the **browser bundle**. A name like `NEXT_PUBLIC_SUPABASE_SERVICE_KEY` would ship a service-role secret to every visitor. |

The exact rule definitions, copied from the file:

```js
const RULES = [
  {
    name: 'Wise funding call (money movement must be draft-only — ADR-0007)',
    re: /\bfundTransfer\b|\bfundWithBalance\b|\.fund\s*\(|\/transfers\/[^'"`\n]*\/payments\b/,
  },
  {
    name: 'Secret exposed via a NEXT_PUBLIC_ env var',
    re: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|SERVICE_KEY|PRIVATE|PASSWORD)/,
  },
];
```

The first regex blocks the Wise SDK funding helpers `fundTransfer` / `fundWithBalance`, any
`.fund(` method call, and the Wise funding endpoint path `/transfers/{id}/payments`. The second
catches any `NEXT_PUBLIC_*` identifier whose name contains `SECRET`, `SERVICE_ROLE`,
`SERVICE_KEY`, `PRIVATE`, or `PASSWORD`.

## Money invariants

Two ADRs are load-bearing for correctness and safety:

- **Integer centavos via branded types (ADR-0006).** All money is stored and computed as integer
  centavos through branded types in `src/lib/money` — **never floats**. This eliminates an entire
  class of rounding bugs and makes a stray `Number` operation a type error rather than a silent
  drift. The pure money engine is unit-tested against parity fixtures from real pay periods. See
  [Money core spec](./money-core-spec.md).
- **Wise is draft-only (ADR-0007).** The Wise module prepares quotes, recipients, and **draft**
  transfers and then stops — it never calls a funding endpoint. The owner reviews and funds in the
  Wise UI. This is documented in headers across `src/server/wise/client.ts`,
  `src/server/actions/wise.ts`, and the `wise-payouts` edge function, and is enforced at build
  time by the guardrail scanner above. See [Wise payouts](./wise.md).

## Secrets

Secrets are **server-side only**. `src/server/env.ts` is a `server-only` module that validates
the environment with Zod **at boot** and fails fast with a list of issues. The browser-exposed
keys are deliberately limited to the public Supabase URL and anon key:

```js
NEXT_PUBLIC_SUPABASE_URL: z.string().url().startsWith('http', 'must be a Supabase URL'),
NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
SUPABASE_SERVICE_KEY: z.string().min(20),
```

The service-role key (`SUPABASE_SERVICE_KEY`) is **not** prefixed `NEXT_PUBLIC_`, so it never
reaches the client bundle; it is used only by `createServiceClient()` behind an explicit admin
role check (see [Architecture](./architecture.md)). Integration secrets — `WISE_API_TOKEN`,
`WISE_PROFILE_ID`, `HUBSTAFF_REFRESH_TOKEN`, `CRON_SECRET`, `GMAIL_USER` / `GMAIL_APP_PASSWORD`,
and the PHI key vars — are **optional at boot** and validate lazily in their adapters, so a
missing credential makes the feature a no-op rather than crashing the app.

Carrying any secret on a `NEXT_PUBLIC_*` var is blocked by `scripts/guardrails.mjs`. For the full
secret inventory and where each is set, see [Cron & secrets](./cron-and-secrets.md).

## PHI encryption

Sensitive fields — the contractor `signature_data` captured during onboarding, and worker-tools
PHI — are protected with **app-layer envelope encryption** (AES-256-GCM) implemented in
`src/lib/crypto/envelope.ts` and exposed through `src/server/crypto/index.ts`.

### The seam

```ts
// Encrypt for storage when configured; otherwise return the plaintext unchanged.
export const encryptIfConfigured = async (plaintext: string): Promise<string> =>
  isPhiEncryptionConfigured() ? encryptField(getKeyProvider(), plaintext) : plaintext;

// Decrypt only values that are envelope tokens; legacy plaintext passes through.
export const decryptIfNeeded = async (value: string): Promise<string> =>
  isEnvelope(value) ? decryptField(getKeyProvider(), value) : value;
```

Writes call `encryptIfConfigured()` (e.g. `src/server/actions/portal.ts` on the signature blob);
reads call `decryptIfNeeded()` (e.g. `src/db/queries/onboarding.ts`). Until a key provider is
configured, both are **no-ops** — values stay plaintext — so wiring them into a path changes
nothing until ops sets a key. Tokens are self-describing and versioned
(`phi.v1.<wrappedDEK>.<iv>.<authTag>.<ciphertext>`); `isEnvelope()` detects the `phi.v1.` prefix,
so **legacy plaintext rows and encrypted rows coexist** during and after a backfill.

### Key providers

Encryption never uses the master key directly: a fresh random data key (DEK) encrypts each value
and is wrapped by the key-encryption key (KEK) — exactly AWS KMS's `GenerateDataKey` / `Decrypt`
model, so the provider is a single swappable adapter. `PHI_KMS_PROVIDER` selects the source:

| Provider | Selected by | Key source | Notes |
|---|---|---|---|
| `local` | `PHI_KMS_PROVIDER=local` (default) | `PHI_LOCAL_MASTER_KEY` — base64 **32-byte** master key | Dev/test. Exercises the exact envelope flow; not a KMS substitute for prod. |
| `aws` | `PHI_KMS_PROVIDER=aws` | `PHI_KMS_KEY_ID` (CMK) via AWS KMS | Production. Runtime needs `kms:GenerateDataKey` + `kms:Decrypt`. **Adapter is an integration stub** (`src/server/crypto/aws-kms-provider.ts`) — it throws until `@aws-sdk/client-kms` is wired. |

`getKeyProvider()` **fails loudly** if the selected provider is misconfigured (e.g. `aws` without
`PHI_KMS_KEY_ID`, or a `local` master key that isn't 32 bytes) — PHI must never be encrypted under
a silently-wrong or default key. Because values are wrapped under the active master key, switching
providers requires a planned re-encrypt/backfill. PHI handling is also covered from the data side
in [Onboarding & documents](./onboarding-documents.md).

## Auth & RLS

The full model lives in [Architecture](./architecture.md); the security-relevant shape:

- **Single-origin path + role gate** (`src/proxy.ts`). One Next.js app serves admin and portal on
  one Supabase Auth pool; they are separated by path prefix (`/portal/*` → contractor, everything
  else → admin) and a server-side role check. The gate uses the **anon client + RLS only** — no
  service-role secret runs at the edge. Cron routes (`/api/cron/*`) skip the session gate and
  self-authenticate with `x-cron-secret`.
- **Re-verification at point of use.** The proxy gate is the first line of defense; every server
  action re-verifies identity with `getCurrentAdmin()` (`src/server/auth/admin.ts`) or
  `getCurrentWorker()` (`src/server/auth/worker.ts`) — the second line (ADR-0004).
- **Contractor RLS scoping.** `getCurrentWorker()` resolves `contractor_logins` filtered to
  `status = 'active'`, mirroring the database RLS helper `my_worker_id()` exactly, so a revoked
  login resolves to no worker even on service-role paths that bypass RLS. A contractor only ever
  reads their own rows.

## Database safety

ABC Helper shares its production Supabase project (`cgsidolrauzsowqlllsz`) with three live
original apps, so **this repo's migration lineage must never be pushed to prod**. Two backstops
enforce that:

- **`pnpm db:guard`** (`scripts/assert-local-supabase-target.mjs`) runs before
  `supabase db push` (the `db:push` script is `npm run db:guard && supabase db push`). If the
  checkout is linked to the shared prod ref, it exits `1` loudly:

  ```js
  const PROD_REF = 'cgsidolrauzsowqlllsz'; // shared prod — never a repo-migration target
  const REF_FILE = 'supabase/.temp/project-ref';
  ```

- **In-DB backstop.** The guard migration `00000000000000_assert_not_shared_prod.sql` catches a
  raw `supabase db push` that bypasses the npm script.

Prod-side schema changes go **only** through `audit/*.sql` applied in the Dashboard SQL Editor,
kept additive so the old app remains the rollback. See [Shared-prod conformance](./shared-prod-conformance.md)
(tracked in `docs/PROD-CONFORMANCE-PLAN.md`).

## See also

- [Architecture overview](./architecture.md) — surfaces, request lifecycle, the auth gate
- [Wise payouts (draft-only)](./wise.md) — the no-funding invariant in practice
- [Money core spec](./money-core-spec.md) — integer-centavos math
- [Cron & secrets](./cron-and-secrets.md) — the full secret inventory
- [Shared-prod conformance](./shared-prod-conformance.md) — the never-push-to-prod plan
- [Onboarding & documents](./onboarding-documents.md) — where PHI (`signature_data`) is produced
