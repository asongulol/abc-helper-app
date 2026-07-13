-- Finding #047 — allocate_invoice_no() re-proposes the same invoice_no forever
-- once the year's highest number belongs to a void invoice.
--
-- allocate_invoice_no() (00000000000004_invoice_no_atomic.sql) computed
-- max(NNNN)+1 over `status <> 'void'` rows, but invoices_invoice_no_unique
-- (also from that migration) covers ALL rows with invoice_no NOT NULL — voided
-- invoices keep their number under the unique index. So once the highest
-- number in a year is void, every subsequent allocation proposes that same
-- number again, and the insert fails the unique index every time (surfaced to
-- the caller as a duplicate-key error).
--
-- Fix: drop the `status <> 'void'` predicate from the max() scan. Void rows
-- still occupy their number (matching the unique index, which was never
-- scoped by status), and allocation simply moves past them. This is
-- semantics-safe for every caller — numbers only ever advance faster, never
-- reused, never skipped backwards.
--
-- Additive: CREATE OR REPLACE FUNCTION, identical signature/grants/security
-- attributes to 00000000000004. Only the WHERE clause changes.

BEGIN;

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
  -- max()+1 over ALL invoices for the year (including void), parsing the NNNN
  -- suffix of "YYYY-NNNN". Void invoices keep their number under
  -- invoices_invoice_no_unique, so the scan must not skip them or it re-mints
  -- an already-taken number forever. The `like` filter excludes any malformed
  -- legacy values from the ::int cast.
  select coalesce(max((split_part(invoice_no, '-', 2))::int), 0) + 1
    into n
    from public.invoices
   where invoice_no like p_year::text || '-%';
  return p_year::text || '-' || lpad(n::text, 4, '0');
end
$$;

COMMIT;
