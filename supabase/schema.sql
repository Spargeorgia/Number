-- Run once in Supabase Dashboard -> SQL Editor.
create table if not exists public.consents (
  id bigint generated always as identity primary key,
  phone text not null,
  consent_version text not null default 'magniti-sms-v1',
  created_at timestamptz not null default now(),
  constraint consents_phone_format check (phone ~ '^\+9955[0-9]{8}$'),
  constraint consents_phone_version_unique unique (phone, consent_version)
);

alter table public.consents enable row level security;

-- The public browser never talks to Supabase directly. Only the Vercel API,
-- authenticated with the server-side secret key, may access this table.
revoke all on table public.consents from public, anon, authenticated, service_role;
revoke all on sequence public.consents_id_seq from public, anon, authenticated, service_role;

grant select, insert on table public.consents to service_role;
grant usage, select on sequence public.consents_id_seq to service_role;
