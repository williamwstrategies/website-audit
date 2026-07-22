-- Signup trigger repair for Phase 5 billing defaults.
-- Run this in Supabase SQL Editor if signup returns:
-- "Database error saving new user", "AuthRetryableFetchError", or status 500.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  agency_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists agency_name text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

create table if not exists public.agency_branding (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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
alter table public.agency_branding add column if not exists user_id uuid;
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
alter table public.agency_branding alter column id set default gen_random_uuid();

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'professional',
  status text not null default 'incomplete',
  audits_used integer not null default 0,
  audit_limit integer not null default 10,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  payment_status text,
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  ended_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions add column if not exists id uuid default gen_random_uuid();
alter table public.subscriptions add column if not exists user_id uuid;
alter table public.subscriptions add column if not exists plan text not null default 'professional';
alter table public.subscriptions add column if not exists status text not null default 'incomplete';
alter table public.subscriptions add column if not exists audits_used integer not null default 0;
alter table public.subscriptions add column if not exists audit_limit integer not null default 10;
alter table public.subscriptions add column if not exists stripe_customer_id text;
alter table public.subscriptions add column if not exists stripe_subscription_id text;
alter table public.subscriptions add column if not exists stripe_price_id text;
alter table public.subscriptions add column if not exists payment_status text;
alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.subscriptions add column if not exists cancel_at timestamptz;
alter table public.subscriptions add column if not exists ended_at timestamptz;
alter table public.subscriptions add column if not exists current_period_start timestamptz;
alter table public.subscriptions add column if not exists current_period_end timestamptz;
alter table public.subscriptions add column if not exists created_at timestamptz not null default now();
alter table public.subscriptions add column if not exists updated_at timestamptz not null default now();

alter table public.subscriptions alter column id set default gen_random_uuid();
alter table public.subscriptions alter column plan set default 'professional';
alter table public.subscriptions alter column status set default 'incomplete';
alter table public.subscriptions alter column audit_limit set default 10;

create table if not exists public.billing_trial_claims (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  checkout_session_id text,
  created_at timestamptz not null default now()
);

alter table public.billing_trial_claims add column if not exists id uuid default gen_random_uuid();
alter table public.billing_trial_claims add column if not exists email text;
alter table public.billing_trial_claims add column if not exists user_id uuid;
alter table public.billing_trial_claims add column if not exists stripe_customer_id text;
alter table public.billing_trial_claims add column if not exists stripe_subscription_id text;
alter table public.billing_trial_claims add column if not exists checkout_session_id text;
alter table public.billing_trial_claims add column if not exists created_at timestamptz not null default now();

create unique index if not exists billing_trial_claims_email_key
on public.billing_trial_claims (email);

alter table public.billing_trial_claims enable row level security;

drop policy if exists "Trial claims are service role only" on public.billing_trial_claims;

revoke all on public.billing_trial_claims from anon, authenticated;
grant all on public.billing_trial_claims to service_role;

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

do $$
begin
  if not exists (
    select 1
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
      and referenced_schema.nspname = 'auth'
      and referenced_class.relname = 'users'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full_name text := nullif(coalesce(new.raw_user_meta_data->>'name', ''), '');
  v_agency_name text := nullif(coalesce(new.raw_user_meta_data->>'agency_name', ''), '');
begin
  update public.profiles
  set
    email = coalesce(new.email, public.profiles.email, ''),
    full_name = coalesce(v_full_name, public.profiles.full_name),
    agency_name = coalesce(v_agency_name, public.profiles.agency_name),
    updated_at = now()
  where id = new.id;

  if not found then
    insert into public.profiles (id, email, full_name, agency_name)
    values (new.id, coalesce(new.email, ''), v_full_name, v_agency_name);
  end if;

  insert into public.agency_branding (user_id, agency_name)
  select new.id, coalesce(v_agency_name, v_full_name)
  where not exists (
    select 1 from public.agency_branding where user_id = new.id
  );

  insert into public.subscriptions (
    user_id,
    plan,
    status,
    audit_limit,
    audits_used
  )
  select
    new.id,
    'professional',
    'incomplete',
    10,
    0
  where not exists (
    select 1 from public.subscriptions where user_id = new.id
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

insert into public.billing_trial_claims (
  email,
  user_id,
  stripe_customer_id,
  stripe_subscription_id
)
select distinct on (lower(trim(auth.users.email)))
  lower(trim(auth.users.email)),
  auth.users.id,
  subscriptions.stripe_customer_id,
  subscriptions.stripe_subscription_id
from auth.users
join public.subscriptions
  on subscriptions.user_id = auth.users.id
where auth.users.email is not null
  and trim(auth.users.email) <> ''
  and (
    subscriptions.status in ('trialing', 'active', 'past_due', 'unpaid', 'cancelled')
    or subscriptions.stripe_customer_id is not null
    or subscriptions.stripe_subscription_id is not null
  )
on conflict (email) do nothing;
