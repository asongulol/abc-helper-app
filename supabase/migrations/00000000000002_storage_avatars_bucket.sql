-- Avatars storage bucket
-- ---------------------------------------------------------------------------
-- Replaces the legacy design of a 256px JPEG data-URI stuffed into a TEXT
-- column (which bloated every `workers` row and had no CDN). Contractor photos
-- now live as objects in a private `avatars` bucket; `workers.photo_url` keeps
-- only the object path / rendered URL — never an inline `data:` blob.
--
-- Provisioned here (a tracked migration) rather than created by hand in the
-- dashboard, so the schema never drifts from source.
-- ---------------------------------------------------------------------------

-- Private bucket: photos are served via short-lived signed URLs (same pattern
-- as the documents bucket), not public links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880, -- 5 MiB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Path convention: `<worker_id>/<filename>`. Policies key off the first folder.
-- storage.objects already ships with RLS enabled.

-- A contractor may read their own avatar.
create policy "avatars: worker reads own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select (public.my_worker_id())::text)
  );

-- Admins (and the owner — both are rows in admin_users) manage avatars.
create policy "avatars: admin reads"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));

create policy "avatars: admin inserts"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (select public.is_admin()));

create policy "avatars: admin updates"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()))
  with check (bucket_id = 'avatars' and (select public.is_admin()));

create policy "avatars: admin deletes"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (select public.is_admin()));

comment on column public.workers.photo_url is
  'Path/URL of the contractor photo object in the `avatars` Storage bucket. NEVER an inline data: URI (the legacy app stored a base64 JPEG here, bloating every row).';
