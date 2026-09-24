-- Run after the multi-brand production deployment has been verified.
begin;

alter table public.consents
  drop constraint if exists consents_phone_version_unique;

alter table public.consents
  alter column brand drop default,
  alter column consent_version drop default;

commit;
