-- PitchProof reactivation A/B experiment
-- Run this file in Supabase SQL Editor before enabling the experiment in Render.

create extension if not exists "pgcrypto";

create table if not exists public.reactivation_experiment_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  experiment_key text not null,
  variant text not null check (variant in ('reactivation_free_scans', 'reactivation_discount_month')),
  status text not null default 'assigned' check (status in ('assigned', 'activated', 'converted', 'cancelled', 'suppressed', 'excluded')),
  assigned_at timestamptz not null default now(),
  activated_at timestamptz,
  converted_at timestamptz,
  subscription_id text,
  stripe_customer_id text,
  subscription_plan text,
  free_scans_used_before_conversion integer not null default 0 check (free_scans_used_before_conversion >= 0),
  first_payment_amount_cents integer,
  first_payment_at timestamptz,
  first_full_price_renewal_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, experiment_key)
);

create unique index if not exists reactivation_enrollments_email_experiment_idx
  on public.reactivation_experiment_enrollments (lower(email), experiment_key)
  where email is not null;

create index if not exists reactivation_enrollments_experiment_variant_idx
  on public.reactivation_experiment_enrollments (experiment_key, variant, status);

create table if not exists public.reactivation_promotional_credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  enrollment_id uuid references public.reactivation_experiment_enrollments(id) on delete cascade,
  experiment_key text not null,
  variant text not null default 'reactivation_free_scans' check (variant = 'reactivation_free_scans'),
  credits_granted integer not null default 10 check (credits_granted > 0),
  credits_remaining integer not null default 10 check (credits_remaining >= 0),
  status text not null default 'active' check (status in ('active', 'exhausted', 'revoked')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, experiment_key)
);

create index if not exists reactivation_credit_grants_user_active_idx
  on public.reactivation_promotional_credit_grants (user_id, experiment_key, status);

create table if not exists public.reactivation_promotional_credit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  grant_id uuid not null references public.reactivation_promotional_credit_grants(id) on delete cascade,
  experiment_key text not null,
  idempotency_key text not null,
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'refunded')),
  credits integer not null default 1 check (credits > 0),
  website_url text,
  website_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  refunded_at timestamptz,
  unique (user_id, idempotency_key)
);

create index if not exists reactivation_credit_events_experiment_status_idx
  on public.reactivation_promotional_credit_events (experiment_key, status);

create table if not exists public.reactivation_experiment_suppressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  experiment_key text not null,
  reason text not null default 'manual',
  created_at timestamptz not null default now()
);

create unique index if not exists reactivation_suppressions_user_experiment_idx
  on public.reactivation_experiment_suppressions (user_id, experiment_key)
  where user_id is not null;

create unique index if not exists reactivation_suppressions_email_experiment_idx
  on public.reactivation_experiment_suppressions (lower(email), experiment_key)
  where email is not null;

create or replace function public.set_reactivation_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_reactivation_enrollments_updated_at on public.reactivation_experiment_enrollments;
create trigger set_reactivation_enrollments_updated_at
before update on public.reactivation_experiment_enrollments
for each row execute function public.set_reactivation_updated_at();

drop trigger if exists set_reactivation_credit_grants_updated_at on public.reactivation_promotional_credit_grants;
create trigger set_reactivation_credit_grants_updated_at
before update on public.reactivation_promotional_credit_grants
for each row execute function public.set_reactivation_updated_at();

drop trigger if exists set_reactivation_credit_events_updated_at on public.reactivation_promotional_credit_events;
create trigger set_reactivation_credit_events_updated_at
before update on public.reactivation_promotional_credit_events
for each row execute function public.set_reactivation_updated_at();

create or replace function public.reserve_reactivation_promotional_scan(
  p_user_id uuid,
  p_experiment_key text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_existing public.reactivation_promotional_credit_events%rowtype;
  v_grant public.reactivation_promotional_credit_grants%rowtype;
  v_enrollment public.reactivation_experiment_enrollments%rowtype;
  v_event public.reactivation_promotional_credit_events%rowtype;
begin
  if p_user_id is null or nullif(trim(coalesce(p_experiment_key, '')), '') is null then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_promotional_scan_request');
  end if;

  if v_key is null then
    v_key := gen_random_uuid()::text;
  end if;

  select *
    into v_existing
    from public.reactivation_promotional_credit_events
   where user_id = p_user_id
     and idempotency_key = v_key
   limit 1;

  if found then
    return jsonb_build_object(
      'allowed', v_existing.status in ('reserved', 'completed'),
      'reason', case when v_existing.status = 'refunded' then 'promotional_scan_refunded' else '' end,
      'promotional', true,
      'idempotency_key', v_key,
      'event_id', v_existing.id,
      'status', v_existing.status
    );
  end if;

  select *
    into v_grant
    from public.reactivation_promotional_credit_grants
   where user_id = p_user_id
     and experiment_key = p_experiment_key
     and variant = 'reactivation_free_scans'
     and status = 'active'
     and credits_remaining > 0
   limit 1
   for update;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'promotional_scans_unavailable',
      'promotional', true,
      'idempotency_key', v_key
    );
  end if;

  insert into public.reactivation_promotional_credit_events (
    user_id,
    grant_id,
    experiment_key,
    idempotency_key,
    status,
    credits
  )
  values (
    p_user_id,
    v_grant.id,
    p_experiment_key,
    v_key,
    'reserved',
    1
  )
  returning * into v_event;

  update public.reactivation_promotional_credit_grants
     set credits_remaining = greatest(credits_remaining - 1, 0),
         status = case when credits_remaining - 1 <= 0 then 'exhausted' else status end
   where id = v_grant.id
   returning * into v_grant;

  update public.reactivation_experiment_enrollments
     set activated_at = coalesce(activated_at, now()),
         status = case when status = 'assigned' then 'activated' else status end
   where id = v_grant.enrollment_id
   returning * into v_enrollment;

  return jsonb_build_object(
    'allowed', true,
    'reason', '',
    'promotional', true,
    'idempotency_key', v_key,
    'event_id', v_event.id,
    'grant_id', v_grant.id,
    'credits_remaining', v_grant.credits_remaining,
    'experiment_key', p_experiment_key,
    'variant', 'reactivation_free_scans',
    'enrollment_id', v_enrollment.id
  );
end;
$$;

create or replace function public.complete_reactivation_promotional_scan(
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
  v_event public.reactivation_promotional_credit_events%rowtype;
  v_grant public.reactivation_promotional_credit_grants%rowtype;
  v_enrollment public.reactivation_experiment_enrollments%rowtype;
begin
  if p_user_id is null or v_key is null then
    return jsonb_build_object('completed', false, 'reason', 'invalid_promotional_scan_completion');
  end if;

  select *
    into v_event
    from public.reactivation_promotional_credit_events
   where user_id = p_user_id
     and idempotency_key = v_key
   limit 1
   for update;

  if not found then
    return jsonb_build_object('completed', false, 'reason', 'promotional_scan_not_found');
  end if;

  if v_event.status = 'refunded' then
    return jsonb_build_object('completed', false, 'reason', 'promotional_scan_refunded');
  end if;

  update public.reactivation_promotional_credit_events
     set status = 'completed',
         website_url = coalesce(nullif(trim(coalesce(p_website_url, '')), ''), website_url),
         website_score = coalesce(p_website_score, website_score),
         completed_at = coalesce(completed_at, now())
   where id = v_event.id
   returning * into v_event;

  select * into v_grant
    from public.reactivation_promotional_credit_grants
   where id = v_event.grant_id
   limit 1;

  update public.reactivation_experiment_enrollments
     set free_scans_used_before_conversion = (
           select count(*)
             from public.reactivation_promotional_credit_events
            where user_id = p_user_id
              and experiment_key = v_event.experiment_key
              and status = 'completed'
         )
   where id = v_grant.enrollment_id
   returning * into v_enrollment;

  return jsonb_build_object(
    'completed', true,
    'promotional', true,
    'idempotency_key', v_key,
    'event_id', v_event.id,
    'grant_id', v_grant.id,
    'credits_remaining', v_grant.credits_remaining,
    'experiment_key', v_event.experiment_key,
    'variant', 'reactivation_free_scans',
    'enrollment_id', v_enrollment.id
  );
end;
$$;

create or replace function public.refund_reactivation_promotional_scan(
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
  v_event public.reactivation_promotional_credit_events%rowtype;
  v_grant public.reactivation_promotional_credit_grants%rowtype;
begin
  if p_user_id is null or v_key is null then
    return jsonb_build_object('refunded', false, 'reason', 'invalid_promotional_scan_refund');
  end if;

  select *
    into v_event
    from public.reactivation_promotional_credit_events
   where user_id = p_user_id
     and idempotency_key = v_key
   limit 1
   for update;

  if not found then
    return jsonb_build_object('refunded', false, 'reason', 'promotional_scan_not_found');
  end if;

  if v_event.status <> 'reserved' then
    return jsonb_build_object(
      'refunded', false,
      'reason', case when v_event.status = 'completed' then 'promotional_scan_completed' else 'promotional_scan_already_refunded' end,
      'promotional', true
    );
  end if;

  update public.reactivation_promotional_credit_events
     set status = 'refunded',
         refunded_at = now()
   where id = v_event.id
   returning * into v_event;

  update public.reactivation_promotional_credit_grants
     set credits_remaining = credits_remaining + v_event.credits,
         status = 'active'
   where id = v_event.grant_id
   returning * into v_grant;

  return jsonb_build_object(
    'refunded', true,
    'promotional', true,
    'idempotency_key', v_key,
    'event_id', v_event.id,
    'grant_id', v_grant.id,
    'credits_remaining', v_grant.credits_remaining,
    'experiment_key', v_event.experiment_key,
    'variant', 'reactivation_free_scans'
  );
end;
$$;

alter table public.reactivation_experiment_enrollments enable row level security;
alter table public.reactivation_promotional_credit_grants enable row level security;
alter table public.reactivation_promotional_credit_events enable row level security;
alter table public.reactivation_experiment_suppressions enable row level security;

drop policy if exists "Users can view own reactivation enrollment" on public.reactivation_experiment_enrollments;
create policy "Users can view own reactivation enrollment"
  on public.reactivation_experiment_enrollments
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can view own reactivation grants" on public.reactivation_promotional_credit_grants;
create policy "Users can view own reactivation grants"
  on public.reactivation_promotional_credit_grants
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can view own reactivation scan events" on public.reactivation_promotional_credit_events;
create policy "Users can view own reactivation scan events"
  on public.reactivation_promotional_credit_events
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.reactivation_experiment_enrollments from anon, authenticated;
revoke all on public.reactivation_promotional_credit_grants from anon, authenticated;
revoke all on public.reactivation_promotional_credit_events from anon, authenticated;
revoke all on public.reactivation_experiment_suppressions from anon, authenticated;

grant select on public.reactivation_experiment_enrollments to authenticated;
grant select on public.reactivation_promotional_credit_grants to authenticated;
grant select on public.reactivation_promotional_credit_events to authenticated;

grant all on public.reactivation_experiment_enrollments to service_role;
grant all on public.reactivation_promotional_credit_grants to service_role;
grant all on public.reactivation_promotional_credit_events to service_role;
grant all on public.reactivation_experiment_suppressions to service_role;

revoke all on function public.reserve_reactivation_promotional_scan(uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_reactivation_promotional_scan(uuid, text, text, numeric) from public, anon, authenticated;
revoke all on function public.refund_reactivation_promotional_scan(uuid, text) from public, anon, authenticated;

grant execute on function public.reserve_reactivation_promotional_scan(uuid, text, text) to service_role;
grant execute on function public.complete_reactivation_promotional_scan(uuid, text, text, numeric) to service_role;
grant execute on function public.refund_reactivation_promotional_scan(uuid, text) to service_role;
