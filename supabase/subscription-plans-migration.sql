-- Subscription plan restructure, scan balances, and white-label permissions.
-- Safe to run more than once. Does not modify auth, reports, scoring, or scanner data.

alter table public.subscriptions add column if not exists monthly_allowance integer;
alter table public.subscriptions add column if not exists scans_remaining integer;
alter table public.subscriptions add column if not exists used_scans integer not null default 0;
alter table public.subscriptions add column if not exists maximum_rollover integer;
alter table public.subscriptions add column if not exists renewal_date timestamptz;
alter table public.subscriptions add column if not exists subscription_status text;
alter table public.subscriptions add column if not exists extra_scans_remaining integer not null default 0;
alter table public.subscriptions add column if not exists white_label_enabled boolean not null default true;

update public.subscriptions
set
  plan = case
    when lower(trim(coalesce(plan, 'professional'))) in ('starter', 'professional', 'growth', 'enterprise')
      then lower(trim(coalesce(plan, 'professional')))
    else 'professional'
  end,
  subscription_status = coalesce(subscription_status, status, 'incomplete'),
  used_scans = greatest(coalesce(used_scans, 0), coalesce(audits_used, 0)),
  renewal_date = coalesce(renewal_date, current_period_end),
  updated_at = now();

update public.subscriptions
set
  audit_limit = case
    when coalesce(status, '') = 'trialing' then 10
    when plan = 'starter' then 30
    when plan = 'professional' then 150
    when plan = 'growth' then 500
    when plan = 'enterprise' then 0
    else 150
  end,
  monthly_allowance = case
    when coalesce(status, '') = 'trialing' then 10
    when plan = 'starter' then 30
    when plan = 'professional' then 150
    when plan = 'growth' then 500
    when plan = 'enterprise' then null
    else 150
  end,
  maximum_rollover = case
    when plan = 'starter' then 60
    when plan = 'professional' then 300
    when plan = 'growth' then 1000
    when plan = 'enterprise' then null
    else 300
  end,
  scans_remaining = case
    when plan = 'enterprise' then null
    else least(
      case
        when plan = 'starter' then 60
        when plan = 'professional' then 300
        when plan = 'growth' then 1000
        else 300
      end,
      coalesce(
        scans_remaining,
        greatest(
          0,
          case
            when coalesce(status, '') = 'trialing' then 10
            when plan = 'starter' then 30
            when plan = 'professional' then 150
            when plan = 'growth' then 500
            else 150
          end - coalesce(audits_used, 0)
        )
      )
    )
  end,
  white_label_enabled = plan in ('professional', 'growth', 'enterprise'),
  updated_at = now();

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

alter table public.audit_usage_events enable row level security;

drop policy if exists "Audit usage events are viewable by owner" on public.audit_usage_events;
create policy "Audit usage events are viewable by owner"
on public.audit_usage_events for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Branding is insertable by owner" on public.agency_branding;
drop policy if exists "Branding is updateable by owner" on public.agency_branding;

create policy "Branding is insertable by owner"
on public.agency_branding for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.subscriptions
    where subscriptions.user_id = auth.uid()
      and subscriptions.status in ('active', 'trialing')
      and subscriptions.plan in ('professional', 'growth', 'enterprise')
  )
);

create policy "Branding is updateable by owner"
on public.agency_branding for update
to authenticated
using (
  user_id = auth.uid()
  and exists (
    select 1
    from public.subscriptions
    where subscriptions.user_id = auth.uid()
      and subscriptions.status in ('active', 'trialing')
      and subscriptions.plan in ('professional', 'growth', 'enterprise')
  )
)
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.subscriptions
    where subscriptions.user_id = auth.uid()
      and subscriptions.status in ('active', 'trialing')
      and subscriptions.plan in ('professional', 'growth', 'enterprise')
  )
);

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
  v_pending integer := 0;
  v_balance integer := 0;
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
    return jsonb_build_object('allowed', false, 'reason', 'no_subscription', 'idempotency_key', v_key, 'subscription', null);
  end if;

  if coalesce(v_sub.status, '') not in ('active', 'trialing') then
    return jsonb_build_object('allowed', false, 'reason', 'subscription_inactive', 'idempotency_key', v_key, 'subscription', to_jsonb(v_sub));
  end if;

  if v_sub.current_period_end is not null and v_sub.current_period_end <= v_now then
    return jsonb_build_object('allowed', false, 'reason', 'subscription_expired', 'idempotency_key', v_key, 'subscription', to_jsonb(v_sub));
  end if;

  if coalesce(v_sub.plan, '') <> 'enterprise' then
    select count(*) into v_pending
    from public.audit_usage_events
    where subscription_id = v_sub.id
      and status = 'reserved';

    v_balance := coalesce(v_sub.scans_remaining, greatest(0, coalesce(v_sub.audit_limit, 0) - coalesce(v_sub.audits_used, 0)))
      + coalesce(v_sub.extra_scans_remaining, 0)
      - coalesce(v_pending, 0);

    if v_balance <= 0 then
      return jsonb_build_object('allowed', false, 'reason', 'audit_limit_reached', 'idempotency_key', v_key, 'subscription', to_jsonb(v_sub));
    end if;
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
  end if;

  return jsonb_build_object(
    'allowed', v_event.status in ('reserved', 'completed'),
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

  if v_event.status = 'completed' then
    select * into v_sub from public.subscriptions where id = v_event.subscription_id;
    return jsonb_build_object('completed', true, 'reason', 'already_completed', 'idempotency_key', v_key, 'reservation_id', v_event.id, 'subscription', to_jsonb(v_sub));
  end if;

  if v_event.status = 'refunded' then
    return jsonb_build_object('completed', false, 'reason', 'reservation_refunded');
  end if;

  select *
  into v_sub
  from public.subscriptions
  where id = v_event.subscription_id
  for update;

  if found and coalesce(v_sub.plan, '') <> 'enterprise' then
    if coalesce(v_sub.scans_remaining, 0) > 0 then
      update public.subscriptions
      set
        scans_remaining = greatest(0, coalesce(scans_remaining, 0) - 1),
        audits_used = coalesce(audits_used, 0) + 1,
        used_scans = coalesce(used_scans, audits_used, 0) + 1,
        updated_at = now()
      where id = v_sub.id
      returning * into v_sub;
    elsif coalesce(v_sub.extra_scans_remaining, 0) > 0 then
      update public.subscriptions
      set
        extra_scans_remaining = greatest(0, coalesce(extra_scans_remaining, 0) - 1),
        audits_used = coalesce(audits_used, 0) + 1,
        used_scans = coalesce(used_scans, audits_used, 0) + 1,
        updated_at = now()
      where id = v_sub.id
      returning * into v_sub;
    end if;
  elsif found then
    update public.subscriptions
    set
      audits_used = coalesce(audits_used, 0) + 1,
      used_scans = coalesce(used_scans, audits_used, 0) + 1,
      updated_at = now()
    where id = v_sub.id
    returning * into v_sub;
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
    select * into v_sub from public.subscriptions where id = v_event.subscription_id;
    return jsonb_build_object('refunded', false, 'reason', 'reservation_not_refundable', 'status', v_event.status, 'subscription', to_jsonb(v_sub));
  end if;

  update public.audit_usage_events
  set
    status = 'refunded',
    refunded_at = now(),
    updated_at = now()
  where id = v_event.id
  returning * into v_event;

  select * into v_sub from public.subscriptions where id = v_event.subscription_id;

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
