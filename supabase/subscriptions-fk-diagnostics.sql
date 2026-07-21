-- Diagnose the live subscriptions.user_id foreign key target.
-- Run in Supabase SQL Editor and check the constraint_definition output.

select
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as constraint_definition,
  referenced_schema.nspname as referenced_schema,
  referenced_class.relname as referenced_table
from pg_constraint c
join pg_class table_class on table_class.oid = c.conrelid
join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
join pg_class referenced_class on referenced_class.oid = c.confrelid
join pg_namespace referenced_schema on referenced_schema.oid = referenced_class.relnamespace
where table_schema.nspname = 'public'
  and table_class.relname = 'subscriptions'
  and c.contype = 'f'
order by c.conname;

select
  count(*) as auth_user_count
from auth.users;

select
  count(*) as subscription_rows_missing_auth_user
from public.subscriptions
where not exists (
  select 1
  from auth.users
  where auth.users.id = subscriptions.user_id
);
