-- PitchProof Lead Finder schema.
-- Safe to run in the Supabase SQL Editor.
-- This migration only adds Lead Finder tables and policies.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  category text,
  website_url text,
  website_domain text,
  phone text,
  email text,
  email_source_url text,
  email_confidence text,
  email_found_at timestamptz,
  address text,
  city text,
  region text,
  country_code text,
  rating numeric,
  review_count integer,
  source text not null default 'manual',
  external_source_id text,
  scan_status text not null default 'not_scanned',
  scan_id uuid references public.reports(id) on delete set null,
  website_score numeric,
  opportunity_score integer,
  opportunity_label text,
  opportunity_state text,
  opportunity_reasons jsonb not null default '[]'::jsonb,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leads add column if not exists business_name text;
alter table public.leads add column if not exists category text;
alter table public.leads add column if not exists website_url text;
alter table public.leads add column if not exists website_domain text;
alter table public.leads add column if not exists phone text;
alter table public.leads add column if not exists email text;
alter table public.leads add column if not exists email_source_url text;
alter table public.leads add column if not exists email_confidence text;
alter table public.leads add column if not exists email_found_at timestamptz;
alter table public.leads add column if not exists address text;
alter table public.leads add column if not exists city text;
alter table public.leads add column if not exists region text;
alter table public.leads add column if not exists country_code text;
alter table public.leads add column if not exists rating numeric;
alter table public.leads add column if not exists review_count integer;
alter table public.leads add column if not exists source text not null default 'manual';
alter table public.leads add column if not exists external_source_id text;
alter table public.leads add column if not exists scan_status text not null default 'not_scanned';
alter table public.leads add column if not exists scan_id uuid references public.reports(id) on delete set null;
alter table public.leads add column if not exists website_score numeric;
alter table public.leads add column if not exists opportunity_score integer;
alter table public.leads add column if not exists opportunity_label text;
alter table public.leads add column if not exists opportunity_state text;
alter table public.leads add column if not exists opportunity_reasons jsonb not null default '[]'::jsonb;
alter table public.leads add column if not exists last_scanned_at timestamptz;
alter table public.leads add column if not exists created_at timestamptz not null default now();
alter table public.leads add column if not exists updated_at timestamptz not null default now();

alter table public.leads
  drop constraint if exists leads_scan_status_check;

alter table public.leads
  add constraint leads_scan_status_check
  check (scan_status in ('not_scanned', 'queued', 'scanning', 'scanned', 'failed', 'no_website'));

create table if not exists public.lead_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null,
  location text,
  country_code text,
  result_limit integer,
  filters jsonb not null default '{}'::jsonb,
  result_count integer not null default 0,
  provider text not null default 'dataforseo',
  provider_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists leads_user_updated_idx
on public.leads (user_id, updated_at desc);

create index if not exists leads_user_score_idx
on public.leads (user_id, opportunity_score desc nulls last);

create index if not exists leads_user_scan_status_idx
on public.leads (user_id, scan_status);

create index if not exists leads_user_email_idx
on public.leads (user_id, email)
where email is not null and email <> '';

create unique index if not exists leads_user_source_external_idx
on public.leads (user_id, source, external_source_id)
where external_source_id is not null and external_source_id <> '';

create unique index if not exists leads_user_domain_idx
on public.leads (user_id, website_domain)
where website_domain is not null and website_domain <> '';

create unique index if not exists leads_user_business_location_idx
on public.leads (
  user_id,
  lower(business_name),
  lower(coalesce(city, '')),
  lower(coalesce(region, '')),
  lower(coalesce(country_code, ''))
)
where (website_domain is null or website_domain = '')
  and (external_source_id is null or external_source_id = '');

create index if not exists lead_searches_user_created_idx
on public.lead_searches (user_id, created_at desc);

drop trigger if exists set_leads_updated_at on public.leads;
create trigger set_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;
alter table public.lead_searches enable row level security;

revoke all on public.leads from anon, authenticated;
revoke all on public.lead_searches from anon, authenticated;
grant all on public.leads to service_role;
grant all on public.lead_searches to service_role;

drop policy if exists "Leads are viewable by owner" on public.leads;
create policy "Leads are viewable by owner"
on public.leads for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Leads are insertable by owner" on public.leads;
create policy "Leads are insertable by owner"
on public.leads for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Leads are updateable by owner" on public.leads;
create policy "Leads are updateable by owner"
on public.leads for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Leads are deleteable by owner" on public.leads;
create policy "Leads are deleteable by owner"
on public.leads for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Lead searches are viewable by owner" on public.lead_searches;
create policy "Lead searches are viewable by owner"
on public.lead_searches for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Lead searches are insertable by owner" on public.lead_searches;
create policy "Lead searches are insertable by owner"
on public.lead_searches for insert
to authenticated
with check (auth.uid() = user_id);
