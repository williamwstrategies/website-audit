-- Repair stale report user foreign keys.
-- Run this in Supabase SQL Editor if report saving fails with:
-- insert or update on table "reports" violates foreign key constraint "reports_user_id_fkey"

create extension if not exists pgcrypto;

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

alter table public.reports add column if not exists id uuid default gen_random_uuid();
alter table public.reports add column if not exists user_id uuid;
alter table public.reports add column if not exists website_url text;
alter table public.reports add column if not exists website text;
alter table public.reports add column if not exists website_domain text;
alter table public.reports add column if not exists website_name text;
alter table public.reports add column if not exists website_score numeric;
alter table public.reports add column if not exists report_data jsonb;
alter table public.reports add column if not exists scan_status text not null default 'completed';
alter table public.reports add column if not exists created_at timestamptz not null default now();
alter table public.reports add column if not exists updated_at timestamptz not null default now();

alter table public.reports alter column id set default gen_random_uuid();
alter table public.reports alter column scan_status set default 'completed';

update public.reports
set
  website = coalesce(website, website_url),
  website_domain = coalesce(website_domain, public.domain_from_url(website_url)),
  website_name = coalesce(website_name, public.domain_from_url(website_url)),
  scan_status = coalesce(scan_status, 'completed'),
  report_data = coalesce(report_data, '{}'::jsonb)
where website_url is not null;

alter table public.reports drop constraint if exists reports_user_id_fkey;
alter table public.reports drop constraint if exists reports_user_id_auth_users_fkey;

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
      and table_class.relname = 'reports'
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
    execute format('alter table public.reports drop constraint %I', v_constraint);
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
      and table_class.relname = 'reports'
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
    alter table public.reports
      add constraint reports_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

create index if not exists reports_user_id_idx on public.reports (user_id);
create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_website_domain_idx on public.reports (website_domain);

alter table public.reports enable row level security;

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

select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition
from pg_constraint c
where c.conrelid = 'public.reports'::regclass
  and c.contype = 'f'
  and exists (
    select 1
    from unnest(c.conkey) key_column(attnum)
    join pg_attribute attribute
      on attribute.attrelid = c.conrelid
     and attribute.attnum = key_column.attnum
    where attribute.attname = 'user_id'
  );
