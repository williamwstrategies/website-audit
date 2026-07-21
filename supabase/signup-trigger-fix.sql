-- Signup trigger repair for Phase 5 billing defaults.
-- Run this if Supabase Auth signup returns "Database error saving new user"
-- or an empty "{}" message after the billing migration.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, agency_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data->>'name', ''), ''),
    nullif(coalesce(new.raw_user_meta_data->>'agency_name', ''), '')
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    agency_name = coalesce(excluded.agency_name, public.profiles.agency_name),
    updated_at = now();

  insert into public.agency_branding (user_id, agency_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'agency_name', ''),
      nullif(new.raw_user_meta_data->>'name', '')
    )
  )
  on conflict (user_id) do nothing;

  insert into public.subscriptions (
    user_id,
    plan,
    status,
    audit_limit,
    audits_used
  )
  values (
    new.id,
    'professional',
    'incomplete',
    100,
    0
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();
