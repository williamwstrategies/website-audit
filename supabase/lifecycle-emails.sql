-- Lifecycle email tracking for account setup reminders.
-- Run this once in Supabase SQL Editor before enabling automated sends.

create extension if not exists pgcrypto;

create table if not exists public.lifecycle_email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  campaign text not null,
  step text not null,
  status text not null default 'sent',
  provider text not null default 'resend',
  provider_message_id text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lifecycle_email_events add column if not exists id uuid default gen_random_uuid();
alter table public.lifecycle_email_events add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.lifecycle_email_events add column if not exists email text;
alter table public.lifecycle_email_events add column if not exists campaign text;
alter table public.lifecycle_email_events add column if not exists step text;
alter table public.lifecycle_email_events add column if not exists status text not null default 'sent';
alter table public.lifecycle_email_events add column if not exists provider text not null default 'resend';
alter table public.lifecycle_email_events add column if not exists provider_message_id text;
alter table public.lifecycle_email_events add column if not exists error text;
alter table public.lifecycle_email_events add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.lifecycle_email_events add column if not exists sent_at timestamptz;
alter table public.lifecycle_email_events add column if not exists created_at timestamptz not null default now();
alter table public.lifecycle_email_events add column if not exists updated_at timestamptz not null default now();

create unique index if not exists lifecycle_email_events_email_campaign_step_key
on public.lifecycle_email_events (lower(email), campaign, step);

create index if not exists lifecycle_email_events_campaign_step_idx
on public.lifecycle_email_events (campaign, step, sent_at desc);

create table if not exists public.lifecycle_email_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  campaign text not null default 'all',
  token_hash text,
  created_at timestamptz not null default now()
);

alter table public.lifecycle_email_unsubscribes add column if not exists id uuid default gen_random_uuid();
alter table public.lifecycle_email_unsubscribes add column if not exists email text;
alter table public.lifecycle_email_unsubscribes add column if not exists campaign text not null default 'all';
alter table public.lifecycle_email_unsubscribes add column if not exists token_hash text;
alter table public.lifecycle_email_unsubscribes add column if not exists created_at timestamptz not null default now();

create unique index if not exists lifecycle_email_unsubscribes_email_campaign_key
on public.lifecycle_email_unsubscribes (lower(email), campaign);

alter table public.lifecycle_email_events enable row level security;
alter table public.lifecycle_email_unsubscribes enable row level security;

revoke all on public.lifecycle_email_events from anon, authenticated;
revoke all on public.lifecycle_email_unsubscribes from anon, authenticated;
grant all on public.lifecycle_email_events to service_role;
grant all on public.lifecycle_email_unsubscribes to service_role;

create or replace function public.set_lifecycle_email_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_lifecycle_email_events_updated_at on public.lifecycle_email_events;
create trigger set_lifecycle_email_events_updated_at
before update on public.lifecycle_email_events
for each row execute function public.set_lifecycle_email_updated_at();
