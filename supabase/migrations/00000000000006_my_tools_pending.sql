-- F-3 — Let a contractor check whether a one-time tools reveal is waiting WITHOUT
-- calling get_my_tools() (which decrypts + permanently purges the credentials). The
-- portal needs a non-destructive "is there a ToolsPopup to show?" gate; worker_tools
-- has no contractor SELECT policy, so expose just the boolean via a SECURITY DEFINER
-- self-scoped helper (resolves the caller via my_worker_id()). Additive.

BEGIN;

CREATE OR REPLACE FUNCTION public.my_tools_pending()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  select coalesce(
    (select popup_pending from public.worker_tools where worker_id = public.my_worker_id()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.my_tools_pending() FROM public;
GRANT EXECUTE ON FUNCTION public.my_tools_pending() TO authenticated, service_role;

COMMIT;
