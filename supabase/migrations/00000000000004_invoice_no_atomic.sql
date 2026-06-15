-- F-1 — Make client-invoice numbering collision-proof (Appendix C: allocate_invoice_no
-- was count-based, not atomic, and invoice_no had no unique constraint).
--
-- (a) Partial UNIQUE index on invoice_no (guarded so it is a no-op if pre-existing
--     duplicates exist — an operator resolves those, then re-runs).
-- (b) Replace the count-based allocator with an advisory-lock + max()-based one (same
--     signature, so callers are unchanged): the txn-scoped advisory lock serializes
--     concurrent generate() calls, and max()+1 (vs count()) never reuses a number
--     after a void. The UNIQUE index is the backstop.
--
-- Additive: CREATE OR REPLACE FUNCTION + CREATE UNIQUE INDEX IF NOT EXISTS. The old
-- app never relied on either, so it remains a valid rollback target.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE invoice_no IS NOT NULL
    GROUP BY invoice_no HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'invoices.invoice_no has duplicate values; skipping unique index. Resolve duplicates then re-run this migration.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_no_unique
      ON public.invoices (invoice_no) WHERE invoice_no IS NOT NULL;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.allocate_invoice_no(p_year integer)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
declare
  n int;
begin
  -- Serialize concurrent allocations for the same year (transaction-scoped,
  -- auto-released on commit/rollback).
  perform pg_advisory_xact_lock(hashtext('allocate_invoice_no'), p_year);
  -- max()+1 over live invoices for the year, parsing the NNNN suffix of "YYYY-NNNN".
  -- The `like` filter excludes any malformed legacy values from the ::int cast.
  select coalesce(max((split_part(invoice_no, '-', 2))::int), 0) + 1
    into n
    from public.invoices
   where invoice_no like p_year::text || '-%'
     and status <> 'void';
  return p_year::text || '-' || lpad(n::text, 4, '0');
end
$$;

COMMIT;
