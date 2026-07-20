-- LeadCheck SaaS foundation schema.
-- Run this in the Supabase SQL editor after creating the project.

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

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  subscription_status text not null default 'trial',
  plan text not null default 'starter',
  audits_used integer not null default 0,
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  website text not null,
  website_score numeric,
  report_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reports_user_id_created_at_idx
  on public.reports (user_id, created_at desc);

create index if not exists reports_user_id_website_idx
  on public.reports (user_id, website);

create table if not exists public.agency_branding (
  user_id uuid primary key references public.users(id) on delete cascade,
  agency_name text,
  logo text,
  primary_color text,
  secondary_color text,
  website text,
  phone text,
  email text,
  booking_link text,
  favicon text,
  tagline text,
  report_disclaimer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references public.users(id) on delete cascade,
  status text not null default 'trialing',
  plan text not null default 'starter',
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists set_reports_updated_at on public.reports;
create trigger set_reports_updated_at
before update on public.reports
for each row execute function public.set_updated_at();

drop trigger if exists set_agency_branding_updated_at on public.agency_branding;
create trigger set_agency_branding_updated_at
before update on public.agency_branding
for each row execute function public.set_updated_at();

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data->>'name', ''), '')
  )
  on conflict (id) do update
  set
    email = excluded.email,
    name = coalesce(excluded.name, public.users.name),
    updated_at = now();

  insert into public.agency_branding (user_id, agency_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'agency_name', ''), nullif(new.raw_user_meta_data->>'name', '')))
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

alter table public.users enable row level security;
alter table public.reports enable row level security;
alter table public.agency_branding enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "Users can read own profile" on public.users;
create policy "Users can read own profile"
on public.users for select
to authenticated
using (id = auth.uid());

drop policy if exists "Users can insert own profile" on public.users;
create policy "Users can insert own profile"
on public.users for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "Users can update own profile" on public.users;
create policy "Users can update own profile"
on public.users for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "Users can read own reports" on public.reports;
create policy "Users can read own reports"
on public.reports for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can create own reports" on public.reports;
create policy "Users can create own reports"
on public.reports for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update own reports" on public.reports;
create policy "Users can update own reports"
on public.reports for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete own reports" on public.reports;
create policy "Users can delete own reports"
on public.reports for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can read own branding" on public.agency_branding;
create policy "Users can read own branding"
on public.agency_branding for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can create own branding" on public.agency_branding;
create policy "Users can create own branding"
on public.agency_branding for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update own branding" on public.agency_branding;
create policy "Users can update own branding"
on public.agency_branding for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can read own subscription" on public.subscriptions;
create policy "Users can read own subscription"
on public.subscriptions for select
to authenticated
using (user_id = auth.uid());
