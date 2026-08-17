alter table public.subscriptions add column if not exists ai_scan_limit integer;
alter table public.subscriptions add column if not exists ai_scans_used integer not null default 0;
alter table public.subscriptions add column if not exists subscription_status text;

update public.subscriptions
set ai_scan_limit = case
  when plan = 'starter' then 10
  when plan = 'professional' then 30
  when plan = 'growth' then 100
  when plan = 'enterprise' then null
  else 30
end
where coalesce(nullif(status, ''), nullif(subscription_status, ''), '') in ('active', 'trialing')
  and ai_scan_limit is null;

update public.subscriptions
set ai_scan_limit = 0
where coalesce(nullif(status, ''), nullif(subscription_status, ''), '') not in ('active', 'trialing')
  and ai_scan_limit is null;

create table if not exists public.ai_visibility_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  domain text not null,
  business_category text not null,
  primary_service text not null,
  city text not null,
  region text not null,
  country_code text not null,
  score numeric,
  label text,
  prompt_set_version text,
  prompts_tested integer not null default 0,
  mention_count integer not null default 0,
  recommendation_count integer not null default 0,
  citation_count integer not null default 0,
  mention_rate numeric,
  recommendation_rate numeric,
  citation_rate numeric,
  average_position numeric,
  queries jsonb not null default '[]'::jsonb,
  competitors jsonb not null default '[]'::jsonb,
  missed_opportunities jsonb not null default '[]'::jsonb,
  summary text,
  provider text,
  model text,
  provider_cost numeric(12, 6),
  average_cost_per_prompt numeric(12, 6),
  successful_requests integer not null default 0,
  failed_requests integer not null default 0,
  status text not null default 'complete',
  cache_hit boolean not null default false,
  usage_recorded_at timestamptz,
  assessment_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_visibility_reports_user_created_idx
on public.ai_visibility_reports (user_id, created_at desc);

create index if not exists ai_visibility_reports_user_domain_idx
on public.ai_visibility_reports (user_id, domain);

drop trigger if exists set_ai_visibility_reports_updated_at on public.ai_visibility_reports;
create trigger set_ai_visibility_reports_updated_at
before update on public.ai_visibility_reports
for each row execute function public.set_updated_at();

alter table public.ai_visibility_reports enable row level security;

revoke all on public.ai_visibility_reports from anon, authenticated;
grant select on public.ai_visibility_reports to authenticated;
grant all on public.ai_visibility_reports to service_role;

drop policy if exists "AI Visibility reports are viewable by owner" on public.ai_visibility_reports;
create policy "AI Visibility reports are viewable by owner"
on public.ai_visibility_reports for select
to authenticated
using (user_id = auth.uid());

create or replace function public.record_ai_visibility_usage(
  p_user_id uuid,
  p_report_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_report public.ai_visibility_reports%rowtype;
  v_unlimited boolean := false;
  v_now timestamptz := now();
begin
  select *
  into v_report
  from public.ai_visibility_reports
  where user_id = p_user_id
    and id = p_report_id
  for update;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'ai_visibility_report_not_found',
      'subscription', null
    );
  end if;

  if v_report.usage_recorded_at is not null then
    select * into v_sub from public.subscriptions where user_id = p_user_id;
    return jsonb_build_object(
      'allowed', true,
      'reason', 'already_recorded',
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
      'subscription', null
    );
  end if;

  if coalesce(nullif(v_sub.status, ''), nullif(v_sub.subscription_status, ''), '') not in ('active', 'trialing') then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'subscription_inactive',
      'subscription', to_jsonb(v_sub)
    );
  end if;

  if v_sub.current_period_end is not null and v_sub.current_period_end <= v_now then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'subscription_expired',
      'subscription', to_jsonb(v_sub)
    );
  end if;

  v_unlimited := coalesce(v_sub.plan, '') = 'enterprise' or v_sub.ai_scan_limit is null;

  if not v_unlimited
     and (
       coalesce(v_sub.ai_scan_limit, 0) <= 0
       or coalesce(v_sub.ai_scans_used, 0) >= coalesce(v_sub.ai_scan_limit, 0)
     ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'ai_visibility_limit_reached',
      'subscription', to_jsonb(v_sub)
    );
  end if;

  if not v_unlimited then
    update public.subscriptions
    set
      ai_scans_used = coalesce(ai_scans_used, 0) + 1,
      updated_at = now()
    where id = v_sub.id
    returning * into v_sub;
  end if;

  update public.ai_visibility_reports
  set
    usage_recorded_at = now(),
    updated_at = now()
  where id = v_report.id;

  return jsonb_build_object(
    'allowed', true,
    'reason', 'recorded',
    'report_id', p_report_id,
    'subscription', to_jsonb(v_sub)
  );
end;
$$;

revoke all on function public.record_ai_visibility_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_ai_visibility_usage(uuid, uuid) to service_role;
