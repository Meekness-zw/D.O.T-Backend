-- The language each user picked in the app ('en', 'zh', 'pt', 'es'), so
-- notifications reach them in it. The app sends it with the push token.
-- Safe to run more than once.

alter table public.user_profiles
  add column if not exists app_language text not null default 'en';

alter table public.user_profiles
  drop constraint if exists user_profiles_app_language_check;

alter table public.user_profiles
  add constraint user_profiles_app_language_check
  check (app_language in ('en', 'zh', 'pt', 'es'));
