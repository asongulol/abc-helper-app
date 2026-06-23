-- Adopt the shared-prod PERSISTENT worker-tools model (local parity).
-- ---------------------------------------------------------------------------
-- abc-helper-app had hardened the tool-credential flow into a ONE-TIME
-- reveal-and-purge model: get_my_tools() and reveal_worker_tools() decrypted the
-- credential, then permanently NULLed worker_tools.enc.
--
-- But abc-helper-app now SHARES the prod DB (and the worker_tools table) with the
-- original apps, which use a PERSISTENT model — their get_my_tools() /
-- decrypt_worker_tools() re-read enc and never purge. If abc-helper-app purged,
-- it would delete a worker's tool credentials out from under the live apps.
--
-- So we conform to prod's functions: decrypt re-readably, never purge. This makes
-- a from-scratch local DB behave like prod. (PROD already HAS decrypt_worker_tools;
-- the only object prod still lacks is the read-only my_tools_pending(), staged
-- separately in audit/prod-additive-tools-functions.sql.)
-- ---------------------------------------------------------------------------

BEGIN;

-- Admin decrypt — PERSISTENT (replaces the one-time-purge reveal_worker_tools).
-- Matches prod's decrypt_worker_tools exactly.
CREATE OR REPLACE FUNCTION public.decrypt_worker_tools(p_worker_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
declare k text; e text;
begin
  select enc into e from worker_tools where worker_id = p_worker_id;
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb;
end$$;
ALTER FUNCTION public.decrypt_worker_tools(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.decrypt_worker_tools(uuid) FROM public;
GRANT ALL ON FUNCTION public.decrypt_worker_tools(uuid) TO service_role;

-- Worker self-view — PERSISTENT (no longer purges enc). Matches prod's get_my_tools.
-- The popup is dismissed via ack_my_tools() (clears popup_pending), not by purging.
CREATE OR REPLACE FUNCTION public.get_my_tools()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
declare k text; e text; pend boolean;
begin
  select enc, popup_pending into e, pend from worker_tools where worker_id = my_worker_id();
  if e is null then return null; end if;
  select value into k from app_secrets where key='tools_enc_key';
  return jsonb_build_object('popup_pending', pend,
    'creds', extensions.pgp_sym_decrypt(extensions.dearmor(e), k)::jsonb);
end$$;
ALTER FUNCTION public.get_my_tools() OWNER TO postgres;

-- Retire the one-time-purge admin reveal — prod doesn't have it and the app now
-- uses decrypt_worker_tools. (worker_tools.revealed_at is left in place, unused;
-- prod also carries it now as an additive column.)
DROP FUNCTION IF EXISTS public.reveal_worker_tools(uuid);

COMMIT;
