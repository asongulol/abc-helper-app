-- contractor-docs storage bucket (onboarding documents)
-- ---------------------------------------------------------------------------
-- uploadOwnDocument / getDocumentSignedUrl / getAdminDocumentUrl all reference a
-- private `contractor-docs` bucket, but (unlike `avatars`) it was never
-- provisioned in source — so contractor document upload + preview silently
-- failed ("Bucket not found"). Mirrors the avatars-bucket migration.
--
-- FIX: the admin policies below originally resolved the owning worker via
-- `public.workers.user_id` — a column that NO migration creates (it does not
-- exist on `workers`). That made this migration error on every clean apply
-- (`column w.user_id does not exist`), so a from-scratch `supabase db reset`
-- / CI build failed here. The owning worker is actually resolved through
-- `public.contractor_logins.auth_user_id` (the auth uid → worker_id link,
-- defined in the baseline), which matches the `<auth_user_id>/...` path
-- convention documented below. Policies are now created idempotently
-- (drop-if-exists first) so environments that partially applied the original
-- can re-run this cleanly.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'contractor-docs',
  'contractor-docs',
  false,
  10485760, -- 10 MiB (matches uploadOwnDocument MAX_BYTES)
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  -- Self-heal config drift: if the bucket was pre-created (e.g. by hand as a
  -- PUBLIC bucket while debugging "Bucket not found"), enforce the intended
  -- private + size/MIME-limited config rather than silently leaving it insecure.
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: `<auth_user_id>/<kind>/<file>` (uploadOwnDocument), where the
-- first segment is the owning contractor's auth uid. The app mediates all access
-- via service-role server actions (ownership re-checked there), so these policies
-- are defence-in-depth for any direct client access — and are scoped PER TENANT:
-- an admin may only touch objects of a worker they can see (admin_can_see_worker:
-- owner sees all; a company-admin sees workers in their companies). Without this,
-- a plain is_admin() check would let any admin read every company's documents.

-- A contractor may read their own uploads.
drop policy if exists "contractor-docs: worker reads own" on storage.objects;
create policy "contractor-docs: worker reads own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'contractor-docs'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Resolve the object's owning worker from the path's auth-uid segment (via the
-- contractor_logins link) and gate on whether the current admin/owner may see it.
drop policy if exists "contractor-docs: admin reads" on storage.objects;
create policy "contractor-docs: admin reads"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'contractor-docs'
    and exists (
      select 1 from public.contractor_logins cl
      where cl.auth_user_id = ((storage.foldername(name))[1])::uuid
        and (select public.admin_can_see_worker(cl.worker_id))
    )
  );

drop policy if exists "contractor-docs: admin inserts" on storage.objects;
create policy "contractor-docs: admin inserts"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'contractor-docs'
    and exists (
      select 1 from public.contractor_logins cl
      where cl.auth_user_id = ((storage.foldername(name))[1])::uuid
        and (select public.admin_can_see_worker(cl.worker_id))
    )
  );

drop policy if exists "contractor-docs: admin updates" on storage.objects;
create policy "contractor-docs: admin updates"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'contractor-docs'
    and exists (
      select 1 from public.contractor_logins cl
      where cl.auth_user_id = ((storage.foldername(name))[1])::uuid
        and (select public.admin_can_see_worker(cl.worker_id))
    )
  )
  with check (
    bucket_id = 'contractor-docs'
    and exists (
      select 1 from public.contractor_logins cl
      where cl.auth_user_id = ((storage.foldername(name))[1])::uuid
        and (select public.admin_can_see_worker(cl.worker_id))
    )
  );

drop policy if exists "contractor-docs: admin deletes" on storage.objects;
create policy "contractor-docs: admin deletes"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'contractor-docs'
    and exists (
      select 1 from public.contractor_logins cl
      where cl.auth_user_id = ((storage.foldername(name))[1])::uuid
        and (select public.admin_can_see_worker(cl.worker_id))
    )
  );
