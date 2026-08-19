-- Repair agency_branding.user_id foreign keys.
-- Run this in the Supabase SQL Editor if saving branding returns:
-- insert or update on table "agency_branding" violates foreign key constraint "agency_branding_user_id_fkey"

create extension if not exists pgcrypto;

alter table public.agency_branding add column if not exists id uuid default gen_random_uuid();
alter table public.agency_branding add column if not exists user_id uuid;

update public.agency_branding
set id = gen_random_uuid()
where id is null;

alter table public.agency_branding alter column id set not null;

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
      and table_class.relname = 'agency_branding'
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
    execute format('alter table public.agency_branding drop constraint %I', v_constraint);
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
      and table_class.relname = 'agency_branding'
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
    alter table public.agency_branding
      add constraint agency_branding_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.agency_branding'::regclass
      and conname = 'agency_branding_user_id_key'
  )
  and not exists (
    select 1
    from public.agency_branding
    where user_id is not null
    group by user_id
    having count(*) > 1
  ) then
    alter table public.agency_branding add constraint agency_branding_user_id_key unique (user_id);
  end if;
end;
$$;
