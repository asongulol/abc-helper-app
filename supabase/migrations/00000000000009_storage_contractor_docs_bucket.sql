-- contractor-docs storage bucket (onboarding documents)
-- ---------------------------------------------------------------------------
-- uploadOwnDocument / getDocumentSignedUrl / getAdminDocumentUrl all reference a
-- private `contractor-docs` bucket, but (unlike `avatars`) it was never
-- provisioned in source — so contractor document upload + preview silently
-- failed ("Bucket not found"). Mirrors the avatars-bucket migration.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'contractor-docs',
  'contractor-docs',
  false,
  10485760, -- 10 MiB (matches uploadOwnDocument MAX_BYTES)
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- Path convention: `<auth_user_id>/<kind>/<file>` (uploadOwnDocument). The app
-- mediates all access through service-role server actions (ownership re-checked
-- there), so these policies are defence-in-depth for any direct client access.

-- A contractor may read their own uploads.
create policy "contractor-docs: worker reads own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'contractor-docs'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Admins (and the owner — both are rows in admin_users) manage all documents.
create policy "contractor-docs: admin reads"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'contractor-docs' and (select public.is_admin()));

create policy "contractor-docs: admin inserts"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'contractor-docs' and (select public.is_admin()));

create policy "contractor-docs: admin updates"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'contractor-docs' and (select public.is_admin()))
  with check (bucket_id = 'contractor-docs' and (select public.is_admin()));

create policy "contractor-docs: admin deletes"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'contractor-docs' and (select public.is_admin()));
