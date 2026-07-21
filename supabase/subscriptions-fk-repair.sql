-- Repair stale subscription user foreign keys.
-- Run this in Supabase SQL Editor if checkout fails with:
-- insert or update on table "subscriptions" violates foreign key constraint "subscriptions_user_id_fkey"

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  agency_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'professional',
  status text not null default 'incomplete',
  audits_used integer not null default 0,
  audit_limit integer not null default 100,
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

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists agency_name text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.subscriptions add column if not exists id uuid default gen_random_uuid();
alter table public.subscriptions add column if not exists user_id uuid;
alter table public.subscriptions add column if not exists plan text not null default 'professional';
alter table public.subscriptions add column if not exists status text not null default 'incomplete';
alter table public.subscriptions add column if not exists audits_used integer not null default 0;
alter table public.subscriptions add column if not exists audit_limit integer not null default 100;
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
alter table public.subscriptions alter column audit_limit set default 100;

update public.subscriptions
set id = gen_random_uuid()
where id is null;

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
      add constraint subscriptions_user_id_auth_users_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

update public.profiles
set
  email = coalesce(users.email, public.profiles.email, ''),
  full_name = coalesce(
    public.profiles.full_name,
    nullif(coalesce(users.raw_user_meta_data->>'name', users.raw_user_meta_data->>'full_name', ''), '')
  ),
  agency_name = coalesce(
    public.profiles.agency_name,
    nullif(coalesce(users.raw_user_meta_data->>'agency_name', users.raw_user_meta_data->>'company_name', ''), '')
  ),
  updated_at = now()
from auth.users
where public.profiles.id = users.id;

insert into public.profiles (id, email, full_name, agency_name)
select
  users.id,
  coalesce(users.email, ''),
  nullif(coalesce(users.raw_user_meta_data->>'name', users.raw_user_meta_data->>'full_name', ''), ''),
  nullif(coalesce(users.raw_user_meta_data->>'agency_name', users.raw_user_meta_data->>'company_name', ''), '')
from auth.users
where not exists (
  select 1 from public.profiles where profiles.id = users.id
);

insert into public.subscriptions (
  user_id,
  plan,
  status,
  audit_limit,
  audits_used
)
select
  users.id,
  'professional',
  'incomplete',
  100,
  0
from auth.users
where not exists (
  select 1 from public.subscriptions where subscriptions.user_id = users.id
);

select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition
from pg_constraint c
join pg_class table_class on table_class.oid = c.conrelid
join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
where table_schema.nspname = 'public'
  and table_class.relname = 'subscriptions'
  and c.contype = 'f'
order by c.conname;
