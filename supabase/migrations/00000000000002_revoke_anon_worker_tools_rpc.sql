-- Security hardening: remove UNAUTHENTICATED (anon) access to the worker-tools
-- SECURITY DEFINER RPCs.
--
-- Finding (Supabase security advisor, lint 0028): these functions are
-- `SECURITY DEFINER` and EXECUTE is granted to `PUBLIC` + `anon`, so a
-- logged-out caller can invoke them via `/rest/v1/rpc/<fn>`. For the
-- `p_worker_id`-taking variants that means an unauthenticated request can read
-- or WRITE tool credentials for an arbitrary worker.
--
-- Fix: revoke EXECUTE from PUBLIC and anon. `authenticated` and `service_role`
-- keep their explicit grants, so the app's signed-in flows are unaffected. This
-- is additive and backward-compatible — the old app's admin/portal flows run
-- authenticated, never anon, so nothing legitimate loses access.
--
-- NOTE (follow-up, not in this migration): the three `p_worker_id`-taking
-- functions are still callable by ANY `authenticated` user with an arbitrary
-- worker_id. Their bodies should be reviewed to confirm they enforce
-- caller-owns-worker (auth.uid() ↔ worker) before tightening further. Revoking
-- anon closes the unauthenticated hole, which is the sharp edge.

revoke execute on function public.set_worker_tools(uuid, jsonb)   from public, anon;
revoke execute on function public.set_tools_requested(uuid, jsonb) from public, anon;
revoke execute on function public.get_tools_status(uuid)          from public, anon;
revoke execute on function public.ack_my_tools()                  from public, anon;
revoke execute on function public.get_my_tools()                  from public, anon;
