# Proposal — PHI / sensitive-column encryption

**Status:** awaiting decision · **Audit refs:** 04-database §6 / §7.4–5; 00-summary risks

## Problem (OBSERVED)

The app ships a **BAA template** and references the PH Data Privacy Act
(`00000000000007_seed_agreement_templates.sql`), so it carries a HIPAA/BAA-adjacent posture.
Yet the sensitive columns are **plaintext**, protected only by Supabase platform disk
encryption — queryable in the clear by anyone with DB or service-role access, and present in
backups / read replicas:

| Column | Data | Today |
|---|---|---|
| `workers.payout_account` (jsonb) | bank/financial PII | plaintext (`baseline:1047`) |
| `workers.wise_recipients` (jsonb), `wise_recipient_id/uuid/tag`, `gcash/paymaya/paypal` | financial PII | plaintext |
| `onboarding_signatures.signature_data` | biometric signature image | plaintext |
| `worker_tools.enc` | recoverable tool credentials | **already encrypted** — the precedent ✅ |

## The in-repo precedent (mirror this)

`worker_tools.enc` is encrypted with pgcrypto `pgp_sym_encrypt`/`pgp_sym_decrypt`, key read from
`app_secrets.tools_enc_key`, accessed **only** via `SECURITY DEFINER` RPCs (`set_worker_tools`,
`reveal_worker_tools`), with one-time-reveal-then-null. `worker_tools` has **no RLS read policy**
— all access is forced through the RPCs (`04-database §… worker_tools`). This is a clean, working
column-encryption pattern already in the codebase.

## Options

### Option 1 — pgcrypto column encryption (mirror `worker_tools`)  ⭐ recommended first step
Encrypt the sensitive columns with `pgp_sym_encrypt`, key in `app_secrets`, reads/writes via
`SECURITY DEFINER` RPCs; drop the broad RLS read on those columns.
- **Pro:** consistent with existing code; one migration + a few RPCs; closes table-leak / backup /
  read-replica exposure; no new infra.
- **Con:** the key lives in the **same database** (`app_secrets`) — a service-role/DB compromise
  can still decrypt. Protects against table leakage, **not** against service-key compromise
  (the audit calls this out explicitly).

### Option 2 — app-layer encryption with external KMS (envelope encryption)
Encrypt/decrypt in the Next app using a key held in AWS KMS (or similar); the DB only ever stores
ciphertext.
- **Pro:** key is **not** in the DB; DB compromise alone can't decrypt; strongest separation;
  best BAA story.
- **Con:** real infra (KMS + IAM); the app must mediate **all** reads/writes (no raw SQL access to
  plaintext, which affects Drizzle Studio / ad-hoc queries / the contractor self-read path); per-row
  decrypt latency; larger, separately-scoped project.

### Option 3 — hybrid / phased
Ship Option 1 now (quick, mirrors precedent), escalate to Option 2 if the compliance/BAA review
demands key separation from the DB.

## Cross-cutting nuances (apply to whichever option)
- **Which columns:** payout/financial JSON + `signature_data` at minimum. Confirm scope.
- **Contractor self-read:** contractors currently read their own `workers` row (incl. payout JSON)
  via `workers_contractor_read` RLS. Encryption-via-RPC **changes that access path** — the portal
  payout screens must move to an RPC. Must be designed in, not discovered later.
- **Backfill:** existing plaintext rows must be encrypted in a migration; the column either becomes
  ciphertext-typed or gets a parallel `*_enc` column with the plaintext dropped after backfill.
- **Key rotation:** `app_secrets` key (Opt 1) vs KMS rotation (Opt 2) — define before shipping.

## Recommendation
**Option 1 (pgcrypto, mirroring `worker_tools`)** as the immediate, in-pattern step that removes
plaintext PII from tables/backups — *then* evaluate Option 2 (KMS) as a deliberate compliance
project if key-separation-from-DB is required by the BAA. This is a **compliance decision**, so it
should be made explicitly, not defaulted.

## Decision needed
- Option 1 (pgcrypto now), Option 2 (KMS), or 3 (phased)?
- Column scope: payout/financial JSON only, or also `signature_data`?
- Is "key in the same DB" acceptable for the BAA, or is DB-key-separation a hard requirement?
