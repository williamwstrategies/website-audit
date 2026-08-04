-- Phase: locked complimentary preview report access.
-- Run after complimentary-scan-onboarding.sql.
-- Reports are now accessed through the application API so unpaid preview reports
-- can be server-shaped without exposing full report_data through Supabase REST.

begin;

alter table public.reports enable row level security;

drop policy if exists "Reports are viewable by owner" on public.reports;
drop policy if exists "Reports are insertable by owner" on public.reports;
drop policy if exists "Reports are updateable by owner" on public.reports;
drop policy if exists "Reports are deleteable by owner" on public.reports;

revoke all on public.reports from anon, authenticated;
grant all on public.reports to service_role;

commit;
