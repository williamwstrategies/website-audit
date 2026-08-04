-- Phase: complimentary one-time onboarding assessment.
-- Run this in Supabase SQL Editor before deploying the matching application code.

begin;

alter table public.subscriptions
  add column if not exists complimentary_scan_available boolean not null default false,
  add column if not exists complimentary_scan_reserved_key text,
  add column if not exists complimentary_scan_started_at timestamptz,
  add column if not exists complimentary_scan_used_at timestamptz,
  add column if not exists complimentary_report_id uuid;

-- Existing accounts should not unexpectedly receive a new complimentary scan.
update public.subscriptions
set complimentary_scan_available = false
where complimentary_scan_used_at is not null
   or stripe_customer_id is not null
   or stripe_subscription_id is not null
   or status in ('trialing', 'active', 'past_due', 'unpaid', 'cancelled');

-- New accounts created after this migration receive one complimentary real scan.
alter table public.subscriptions
  alter column complimentary_scan_available set default true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and conname = 'subscriptions_complimentary_report_id_fkey'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_complimentary_report_id_fkey
      foreign key (complimentary_report_id)
      references public.reports(id)
      on delete set null
      not valid;
  end if;
end;
$$;

create index if not exists subscriptions_complimentary_reserved_key_idx
on public.subscriptions (complimentary_scan_reserved_key)
where complimentary_scan_reserved_key is not null;

create index if not exists subscriptions_complimentary_report_id_idx
on public.subscriptions (complimentary_report_id)
where complimentary_report_id is not null;

commit;
