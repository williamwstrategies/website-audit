-- PitchProof Lead Email Finder schema.
-- Safe to run in the Supabase SQL Editor.
-- This migration only adds optional email-discovery fields to saved leads.

alter table public.leads add column if not exists email text;
alter table public.leads add column if not exists email_source_url text;
alter table public.leads add column if not exists email_confidence text;
alter table public.leads add column if not exists email_found_at timestamptz;

create index if not exists leads_user_email_idx
on public.leads (user_id, email)
where email is not null and email <> '';
