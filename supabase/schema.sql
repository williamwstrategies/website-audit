-- LeadCheck Phase 2 SaaS foundation schema.
-- Safe to run in the Supabase SQL Editor.
-- This migration avoids DROP TABLE and preserves any earlier Phase 1 rows.

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

create or replace function public.domain_from_url(input_url text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(coalesce(input_url, '')), '^https?://', ''),
      '/.*$',
      ''
    ),
    ''
  );
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  agency_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  website_url text not null,
  website text,
  website_domain text,
  website_name text,
  website_score numeric,
  report_data jsonb not null,
  scan_status text not null default 'completed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reports add column if not exists website_url text;
alter table public.reports add column if not exists website text;
alter table public.reports add column if not exists website_domain text;
alter table public.reports add column if not exists website_name text;
alter table public.reports add column if not exists website_score numeric;
alter table public.reports add column if not exists report_data jsonb;
alter table public.reports add column if not exists scan_status text not null default 'completed';
alter table public.reports add column if not exists created_at timestamptz not null default now();
alter table public.reports add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reports'
      and column_name = 'website'
  ) then
    execute 'update public.reports set website_url = coalesce(website_url, website) where website_url is null';
  end if;
end;
$$;

update public.reports
set
  website_domain = coalesce(website_domain, public.domain_from_url(website_url)),
  website_name = coalesce(website_name, public.domain_from_url(website_url)),
  website = coalesce(website, website_url),
  scan_status = coalesce(scan_status, 'completed'),
  report_data = coalesce(report_data, '{}'::jsonb)
where website_url is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'reports'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like '%REFERENCES auth.users%'
  ) then
    alter table public.reports
      add constraint reports_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

create table if not exists public.agency_branding (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  agency_name text,
  logo_url text,
  primary_color text,
  secondary_color text,
  website text,
  email text,
  phone text,
  booking_link text,
  favicon_url text,
  tagline text,
  disclaimer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agency_branding add column if not exists id uuid default gen_random_uuid();
alter table public.agency_branding add column if not exists agency_name text;
alter table public.agency_branding add column if not exists logo_url text;
alter table public.agency_branding add column if not exists primary_color text;
alter table public.agency_branding add column if not exists secondary_color text;
alter table public.agency_branding add column if not exists website text;
alter table public.agency_branding add column if not exists email text;
alter table public.agency_branding add column if not exists phone text;
alter table public.agency_branding add column if not exists booking_link text;
alter table public.agency_branding add column if not exists favicon_url text;
alter table public.agency_branding add column if not exists tagline text;
alter table public.agency_branding add column if not exists disclaimer text;
alter table public.agency_branding add column if not exists created_at timestamptz not null default now();
alter table public.agency_branding add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agency_branding' and column_name = 'logo'
  ) then
    execute 'update public.agency_branding set logo_url = coalesce(logo_url, logo) where logo_url is null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agency_branding' and column_name = 'favicon'
  ) then
    execute 'update public.agency_branding set favicon_url = coalesce(favicon_url, favicon) where favicon_url is null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agency_branding' and column_name = 'report_disclaimer'
  ) then
    execute 'update public.agency_branding set disclaimer = coalesce(disclaimer, report_disclaimer) where disclaimer is null';
  end if;
end;
$$;

update public.agency_branding
set id = gen_random_uuid()
where id is null;

alter table public.agency_branding alter column id set not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.agency_branding'::regclass
      and conname = 'agency_branding_pkey'
  ) then
    alter table public.agency_branding drop constraint agency_branding_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agency_branding'::regclass
      and contype = 'p'
  ) then
    alter table public.agency_branding add constraint agency_branding_pkey primary key (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agency_branding'::regclass
      and conname = 'agency_branding_user_id_key'
  ) then
    alter table public.agency_branding add constraint agency_branding_user_id_key unique (user_id);
  end if;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'agency_branding'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like '%REFERENCES auth.users%'
  ) then
    alter table public.agency_branding
      add constraint agency_branding_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null default 'starter',
  status text not null default 'trialing',
  audits_used integer not null default 0,
  audit_limit integer not null default 10,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions add column if not exists id uuid default gen_random_uuid();
alter table public.subscriptions add column if not exists plan text not null default 'starter';
alter table public.subscriptions add column if not exists status text not null default 'trialing';
alter table public.subscriptions add column if not exists audits_used integer not null default 0;
alter table public.subscriptions add column if not exists audit_limit integer not null default 10;
alter table public.subscriptions add column if not exists stripe_customer_id text;
alter table public.subscriptions add column if not exists stripe_subscription_id text;
alter table public.subscriptions add column if not exists current_period_start timestamptz;
alter table public.subscriptions add column if not exists current_period_end timestamptz;
alter table public.subscriptions add column if not exists created_at timestamptz not null default now();
alter table public.subscriptions add column if not exists updated_at timestamptz not null default now();

update public.subscriptions
set id = gen_random_uuid()
where id is null;

alter table public.subscriptions drop constraint if exists subscriptions_user_id_fkey;
alter table public.subscriptions drop constraint if exists subscriptions_user_id_auth_users_fkey;

do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_constraint c
    join pg_class table_class on table_class.oid = c.conrelid
    join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
    join pg_class referenced_class on referenced_class.oid = c.confrelid
    join pg_namespace referenced_schema on referenced_schema.oid = referenced_class.relnamespace
    where table_schema.nspname = 'public'
      and table_class.relname = 'subscriptions'
      and c.contype = 'f'
      and exists (
        select 1
        from unnest(c.conkey) key_column(attnum)
        join pg_attribute attribute
          on attribute.attrelid = c.conrelid
         and attribute.attnum = key_column.attnum
        where attribute.attname = 'user_id'
      )
      and not (
        referenced_schema.nspname = 'auth'
        and referenced_class.relname = 'users'
      )
  loop
    execute format('alter table public.subscriptions drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.subscriptions alter column id set not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and conname = 'subscriptions_pkey'
  ) then
    alter table public.subscriptions drop constraint subscriptions_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and contype = 'p'
  ) then
    alter table public.subscriptions add constraint subscriptions_pkey primary key (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and conname = 'subscriptions_user_id_key'
  ) then
    alter table public.subscriptions add constraint subscriptions_user_id_key unique (user_id);
  end if;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'subscriptions'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like '%REFERENCES auth.users%'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
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
  insert into public.profiles (id, email, full_name, agency_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data->>'name', ''), ''),
    nullif(coalesce(new.raw_user_meta_data->>'agency_name', ''), '')
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    agency_name = coalesce(excluded.agency_name, public.profiles.agency_name),
    updated_at = now();

  insert into public.agency_branding (user_id, agency_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'agency_name', ''),
      nullif(new.raw_user_meta_data->>'name', '')
    )
  )
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

insert into public.profiles (id, email, full_name)
select
  users.id,
  coalesce(users.email, ''),
  nullif(coalesce(users.raw_user_meta_data->>'name', ''), '')
from auth.users
on conflict (id) do update
set
  email = excluded.email,
  full_name = coalesce(public.profiles.full_name, excluded.full_name),
  updated_at = now();

do $$
begin
  if to_regclass('public.users') is not null then
    execute '
      insert into public.profiles (id, email, full_name)
      select id, email, nullif(name, '''')
      from public.users
      on conflict (id) do update
      set
        email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        updated_at = now()
    ';
  end if;
end;
$$;

insert into public.agency_branding (user_id, agency_name)
select profiles.id, profiles.agency_name
from public.profiles
on conflict (user_id) do nothing;

insert into public.subscriptions (user_id)
select profiles.id
from public.profiles
on conflict (user_id) do nothing;

create index if not exists reports_user_id_idx on public.reports (user_id);
create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_website_domain_idx on public.reports (website_domain);
create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);
create index if not exists agency_branding_user_id_idx on public.agency_branding (user_id);

alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.agency_branding enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "Profiles are viewable by owner" on public.profiles;
create policy "Profiles are viewable by owner"
on public.profiles for select
to authenticated
using (id = auth.uid());

drop policy if exists "Profiles are updateable by owner" on public.profiles;
create policy "Profiles are updateable by owner"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "Profiles are insertable by owner" on public.profiles;
create policy "Profiles are insertable by owner"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "Reports are viewable by owner" on public.reports;
create policy "Reports are viewable by owner"
on public.reports for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Reports are insertable by owner" on public.reports;
create policy "Reports are insertable by owner"
on public.reports for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Reports are updateable by owner" on public.reports;
create policy "Reports are updateable by owner"
on public.reports for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Reports are deleteable by owner" on public.reports;
create policy "Reports are deleteable by owner"
on public.reports for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Branding is viewable by owner" on public.agency_branding;
create policy "Branding is viewable by owner"
on public.agency_branding for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Branding is insertable by owner" on public.agency_branding;
create policy "Branding is insertable by owner"
on public.agency_branding for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Branding is updateable by owner" on public.agency_branding;
create policy "Branding is updateable by owner"
on public.agency_branding for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Subscriptions are viewable by owner" on public.subscriptions;
create policy "Subscriptions are viewable by owner"
on public.subscriptions for select
to authenticated
using (user_id = auth.uid());
