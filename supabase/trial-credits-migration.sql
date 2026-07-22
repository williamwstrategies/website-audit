-- Trial credits and one-trial-per-email enforcement.
-- Run this in Supabase SQL Editor before deploying the matching billing code.

create extension if not exists pgcrypto;

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

update public.billing_trial_claims
set email = lower(trim(email))
where email is not null;

create unique index if not exists billing_trial_claims_email_key
on public.billing_trial_claims (email);

alter table public.subscriptions alter column audit_limit set default 10;

update public.subscriptions
set
  audit_limit = 10,
  updated_at = now()
where status = 'trialing'
  and coalesce(audit_limit, 0) <> 10;

update public.subscriptions
set
  audit_limit = 10,
  updated_at = now()
where stripe_customer_id is null
  and stripe_subscription_id is null
  and status = 'incomplete'
  and coalesce(audit_limit, 0) <> 10;

update public.subscriptions
set
  audit_limit = 100,
  updated_at = now()
where status = 'active'
  and stripe_subscription_id is not null
  and coalesce(audit_limit, 0) <> 100;

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

alter table public.billing_trial_claims enable row level security;

drop policy if exists "Trial claims are service role only" on public.billing_trial_claims;

revoke all on public.billing_trial_claims from anon, authenticated;
grant all on public.billing_trial_claims to service_role;
