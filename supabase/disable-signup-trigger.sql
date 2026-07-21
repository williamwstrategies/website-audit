-- Emergency signup fix.
-- Supabase Auth should not depend on app workspace row creation.
-- Run this if signup returns AuthRetryableFetchError/status 500.
--
-- After this trigger is disabled, the app provisions profiles,
-- agency_branding, and subscriptions after the user logs in.

drop trigger if exists on_auth_user_created on auth.users;

select 'Signup trigger disabled. Workspace rows will be provisioned by the app after login.' as result;
