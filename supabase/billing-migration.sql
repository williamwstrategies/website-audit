-- LeadCheck Phase 5 billing, usage limits, and Stripe subscription support.
-- Run this after the Phase 2 schema and Phase 4 storage policies.
-- Safe migration: no drops of user data, no changes to reports/scoring/auth tables.

alter table public.subscriptions add column if not exists stripe_price_id text;
alter table public.subscriptions add column if not exists payment_status text;
alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.subscriptions add column if not exists cancel_at timestamptz;
alter table public.subscriptions add column if not exists ended_at timestamptz;

alter table public.subscriptions alter column plan set default 'professional';
alter table public.subscriptions alter column status set default 'incomplete';
alter table public.subscriptions alter column audit_limit set default 100;

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

update public.subscriptions
set
  plan = 'professional',
  status = 'incomplete',
  audit_limit = 100,
  updated_at = now()
where stripe_customer_id is null
  and stripe_subscription_id is null
  and plan = 'starter'
  and status = 'trialing';

create index if not exists subscriptions_stripe_customer_id_idx
on public.subscriptions (stripe_customer_id)
where stripe_customer_id is not null;

create index if not exists subscriptions_stripe_subscription_id_idx
on public.subscriptions (stripe_subscription_id)
where stripe_subscription_id is not null;

create table if not exists public.audit_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  idempotency_key text not null,
  status text not null default 'reserved',
  website_url text,
  website_score numeric,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  refunded_at timestamptz,
  constraint audit_usage_events_status_check
    check (status in ('reserved', 'completed', 'refunded'))
);

create unique index if not exists audit_usage_events_user_id_idempotency_key_idx
on public.audit_usage_events (user_id, idempotency_key);

create index if not exists audit_usage_events_user_id_created_at_idx
on public.audit_usage_events (user_id, created_at desc);

drop trigger if exists set_audit_usage_events_updated_at on public.audit_usage_events;
create trigger set_audit_usage_events_updated_at
before update on public.audit_usage_events
for each row execute function public.set_updated_at();

alter table public.audit_usage_events enable row level security;

drop policy if exists "Audit usage events are viewable by owner" on public.audit_usage_events;
create policy "Audit usage events are viewable by owner"
on public.audit_usage_events for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Subscriptions are insertable by owner" on public.subscriptions;
drop policy if exists "Subscriptions are updateable by owner" on public.subscriptions;
drop policy if exists "Subscriptions are deleteable by owner" on public.subscriptions;

create or replace function public.reserve_audit_usage(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_sub public.subscriptions%rowtype;
  v_event public.audit_usage_events%rowtype;
  v_now timestamptz := now();
begin
  if v_key is null then
    v_key := gen_random_uuid()::text;
  end if;

  select *
  into v_event
  from public.audit_usage_events
  where user_id = p_user_id
    and idempotency_key = v_key
  limit 1;

  if found then
    select * into v_sub from public.subscriptions where id = v_event.subscription_id;
    return jsonb_build_object(
      'allowed', v_event.status in ('reserved', 'completed'),
      'reason', case
        when v_event.status in ('reserved', 'completed') then 'already_reserved'
        else 'reservation_refunded'
      end,
      'idempotency_key', v_key,
      'reservation_id', v_event.id,
      'subscription', to_jsonb(v_sub)
    );
  end if;

  select *
  into v_sub
  from public.subscriptions
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'no_subscription',
      'idempotency_key', v_key,
      'subscription', null
    );
  end if;

  if coalesce(v_sub.status, '') not in ('active', 'trialing') then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'subscription_inactive',
      'idempotency_key', v_key,
      'subscription', to_jsonb(v_sub)
    );
  end if;

  if v_sub.current_period_end is not null and v_sub.current_period_end <= v_now then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'subscription_expired',
      'idempotency_key', v_key,
      'subscription', to_jsonb(v_sub)
    );
  end if;

  if coalesce(v_sub.audit_limit, 0) <= 0
     or coalesce(v_sub.audits_used, 0) >= coalesce(v_sub.audit_limit, 0) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'audit_limit_reached',
      'idempotency_key', v_key,
      'subscription', to_jsonb(v_sub)
    );
  end if;

  insert into public.audit_usage_events (
    user_id,
    subscription_id,
    idempotency_key,
    status,
    period_start,
    period_end
  )
  values (
    p_user_id,
    v_sub.id,
    v_key,
    'reserved',
    v_sub.current_period_start,
    v_sub.current_period_end
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_event;

  if not found then
    select *
    into v_event
    from public.audit_usage_events
    where user_id = p_user_id
      and idempotency_key = v_key
    limit 1;

    return jsonb_build_object(
      'allowed', v_event.status in ('reserved', 'completed'),
      'reason', 'already_reserved',
      'idempotency_key', v_key,
      'reservation_id', v_event.id,
      'subscription', to_jsonb(v_sub)
    );
  end if;

  update public.subscriptions
  set
    audits_used = coalesce(audits_used, 0) + 1,
    updated_at = now()
  where id = v_sub.id
  returning * into v_sub;

  return jsonb_build_object(
    'allowed', true,
    'reason', 'reserved',
    'idempotency_key', v_key,
    'reservation_id', v_event.id,
    'subscription', to_jsonb(v_sub)
  );
end;
$$;

create or replace function public.complete_audit_usage(
  p_user_id uuid,
  p_idempotency_key text,
  p_website_url text default null,
  p_website_score numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_event public.audit_usage_events%rowtype;
  v_sub public.subscriptions%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('completed', false, 'reason', 'missing_idempotency_key');
  end if;

  select *
  into v_event
  from public.audit_usage_events
  where user_id = p_user_id
    and idempotency_key = v_key
  for update;

  if not found then
    return jsonb_build_object('completed', false, 'reason', 'reservation_not_found');
  end if;

  if v_event.status = 'refunded' then
    return jsonb_build_object('completed', false, 'reason', 'reservation_refunded');
  end if;

  update public.audit_usage_events
  set
    status = 'completed',
    website_url = coalesce(p_website_url, website_url),
    website_score = coalesce(p_website_score, website_score),
    completed_at = coalesce(completed_at, now()),
    updated_at = now()
  where id = v_event.id
  returning * into v_event;

  select * into v_sub from public.subscriptions where id = v_event.subscription_id;

  return jsonb_build_object(
    'completed', true,
    'reason', 'completed',
    'idempotency_key', v_key,
    'reservation_id', v_event.id,
    'subscription', to_jsonb(v_sub)
  );
end;
$$;

create or replace function public.refund_audit_usage(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_event public.audit_usage_events%rowtype;
  v_sub public.subscriptions%rowtype;
begin
  if v_key is null then
    return jsonb_build_object('refunded', false, 'reason', 'missing_idempotency_key');
  end if;

  select *
  into v_event
  from public.audit_usage_events
  where user_id = p_user_id
    and idempotency_key = v_key
  for update;

  if not found then
    return jsonb_build_object('refunded', false, 'reason', 'reservation_not_found');
  end if;

  if v_event.status <> 'reserved' then
    return jsonb_build_object(
      'refunded', false,
      'reason', 'reservation_not_refundable',
      'status', v_event.status
    );
  end if;

  select *
  into v_sub
  from public.subscriptions
  where id = v_event.subscription_id
  for update;

  if found then
    update public.subscriptions
    set
      audits_used = greatest(0, coalesce(audits_used, 0) - 1),
      updated_at = now()
    where id = v_sub.id
    returning * into v_sub;
  end if;

  update public.audit_usage_events
  set
    status = 'refunded',
    refunded_at = now(),
    updated_at = now()
  where id = v_event.id
  returning * into v_event;

  return jsonb_build_object(
    'refunded', true,
    'reason', 'refunded',
    'idempotency_key', v_key,
    'reservation_id', v_event.id,
    'subscription', to_jsonb(v_sub)
  );
end;
$$;

revoke all on function public.reserve_audit_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_audit_usage(uuid, text, text, numeric) from public, anon, authenticated;
revoke all on function public.refund_audit_usage(uuid, text) from public, anon, authenticated;

grant execute on function public.reserve_audit_usage(uuid, text) to service_role;
grant execute on function public.complete_audit_usage(uuid, text, text, numeric) to service_role;
grant execute on function public.refund_audit_usage(uuid, text) to service_role;
