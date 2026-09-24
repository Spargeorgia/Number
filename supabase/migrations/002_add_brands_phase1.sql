-- Run this migration before deploying the multi-brand application.
-- It keeps the old two-column unique constraint temporarily, so the currently
-- deployed Magniti form continues working throughout the rollout.
begin;

alter table public.consents
  add column if not exists brand text;

alter table public.consents
  alter column brand set default 'magniti';

update public.consents
set brand = 'magniti'
where brand is null;

alter table public.consents
  alter column brand set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.consents'::regclass
      and conname = 'consents_brand_allowed'
  ) then
    alter table public.consents
      add constraint consents_brand_allowed
      check (brand in ('magniti', 'kalata', 'spar', 'daily')) not valid;
  end if;
end
$migration$;

alter table public.consents
  validate constraint consents_brand_allowed;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.consents'::regclass
      and conname = 'consents_phone_brand_version_unique'
  ) then
    alter table public.consents
      add constraint consents_phone_brand_version_unique
      unique (phone, brand, consent_version);
  end if;
end
$migration$;

create index if not exists consents_brand_created_at_idx
  on public.consents (brand, created_at desc);

alter table public.consents enable row level security;
revoke all on table public.consents
  from public, anon, authenticated, service_role;
revoke all on sequence public.consents_id_seq
  from public, anon, authenticated, service_role;
grant select, insert on table public.consents to service_role;
grant usage, select on sequence public.consents_id_seq to service_role;

commit;
