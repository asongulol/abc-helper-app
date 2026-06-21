-- 0015 — perf indexes, e-sign evidence protection, invoice AR columns, paid-state
-- completion. Additive and cutover-safe (audit/00-summary §6, audit/03 §4.1,
-- audit/05 §4.2).

BEGIN;

-- 1. Index the unindexed hot-path FKs (audit/04 §4). worker_companies.worker_id is
--    already covered by its (worker_id, company_id) UNIQUE, so only these two remain.
CREATE INDEX IF NOT EXISTS payments_worker_id_idx ON public.payments (worker_id);
CREATE INDEX IF NOT EXISTS invoice_lines_worker_id_idx ON public.invoice_lines (worker_id);

-- 2. onboarding_signatures: make the e-sign ledger tamper-evident at the DB level
--    (audit/03 §4.5). Block UPDATE of the evidentiary columns; deliberately allow
--    signed_date + status (admin corrections — see setSignedDate / editAgreementDate).
--    UPDATE only, NOT DELETE: onboarding_signatures.worker_id is ON DELETE CASCADE from
--    workers, so a DELETE block would break the owner-only delete-hire cascade; RLS
--    already grants authenticated users no delete path.
CREATE OR REPLACE FUNCTION public.onboarding_signatures_protect()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $$
begin
  if ( new.worker_id          is distinct from old.worker_id
    or new.agreement_kind     is distinct from old.agreement_kind
    or new.doc_version        is distinct from old.doc_version
    or new.doc_sha256         is distinct from old.doc_sha256
    or new.signed_legal_name  is distinct from old.signed_legal_name
    or new.signature_method   is distinct from old.signature_method
    or new.signature_data     is distinct from old.signature_data
    or new.scrolled_to_end    is distinct from old.scrolled_to_end
    or new.ip_address         is distinct from old.ip_address
    or new.user_agent         is distinct from old.user_agent
    or new.device_fingerprint is distinct from old.device_fingerprint
    or new.signed_at          is distinct from old.signed_at ) then
    raise exception
      'onboarding_signatures evidence is immutable (id=%); only signed_date and status may be corrected',
      old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
ALTER FUNCTION public.onboarding_signatures_protect() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_onboarding_signatures_protect ON public.onboarding_signatures;
CREATE TRIGGER trg_onboarding_signatures_protect
  BEFORE UPDATE ON public.onboarding_signatures
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_signatures_protect();

-- 3. Invoice accounts-receivable tracking (audit/05 §4.2): a "paid" invoice currently
--    records nothing about how much / when was received. Add nullable AR columns.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_received_usd numeric(14,2);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS received_on date;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_ref text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_amount_received_nonneg' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_amount_received_nonneg
      CHECK (amount_received_usd IS NULL OR amount_received_usd >= 0) NOT VALID;
  END IF;
END $$;

-- 4. Complete the documented open->locked->paid machine for existing data (audit/03
--    §4.1): a locked period whose payments are all sent/reconciled is really paid.
--    Going forward the app keeps this in sync (db/queries/payroll.ts syncPeriodPaidState).
UPDATE public.pay_periods pp SET state = 'paid'
WHERE pp.state = 'locked'
  AND EXISTS (SELECT 1 FROM public.payments p WHERE p.pay_period_id = pp.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.pay_period_id = pp.id AND p.status NOT IN ('sent', 'reconciled')
  );

COMMIT;
