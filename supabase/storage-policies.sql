-- LeadCheck Phase 4 white-label asset storage.
-- Run this in the Supabase SQL Editor after the Phase 2 schema.
-- It creates a private bucket for agency logos and favicons.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'agency-branding',
  'agency-branding',
  false,
  2097152,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own branding assets" on storage.objects;
create policy "Users can read own branding assets"
on storage.objects for select
to authenticated
using (
  bucket_id = 'agency-branding'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can upload own branding assets" on storage.objects;
create policy "Users can upload own branding assets"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'agency-branding'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can replace own branding assets" on storage.objects;
create policy "Users can replace own branding assets"
on storage.objects for update
to authenticated
using (
  bucket_id = 'agency-branding'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'agency-branding'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete own branding assets" on storage.objects;
create policy "Users can delete own branding assets"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'agency-branding'
  and (storage.foldername(name))[1] = auth.uid()::text
);
