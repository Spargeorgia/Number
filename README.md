# Number

Mobile-first Magniti SMS consent page, matched to the supplied 393 × 852 reference.

## Brand pages

- `/` or `/magniti` — Magniti (`magniti-sms-v1`)
- `/kalata` — Kalata (`kalata-sms-v1`)
- `/spar` — SPAR (`spar-sms-v1`)
- `/daily` — Daily (`daily-sms-v1`)

All pages use the same server endpoint and Supabase table. The server derives the
consent version from an allowlisted brand; the browser cannot choose an arbitrary
version.

## Local preview

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Supabase setup

1. Run [`supabase/schema.sql`](supabase/schema.sql) once in the project's Supabase SQL Editor.
2. Add these server-only environment variables to the Vercel project:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
3. Redeploy the production deployment after adding the variables.

For an existing Magniti-only database, run
[`002_add_brands_phase1.sql`](supabase/migrations/002_add_brands_phase1.sql),
deploy the multi-brand application, verify all routes, and then run
[`003_finalize_brands.sql`](supabase/migrations/003_finalize_brands.sql).

`SUPABASE_SECRET_KEY` must only exist in Vercel's encrypted environment-variable
store. Never put it in browser code, source control, chat, email, or screenshots.

## Weekly email report

Vercel Cron calls `/api/export-consents` every Monday at 05:00 UTC (09:00 in
Tbilisi). The function emails a complete UTF-8 CSV snapshot that opens directly
in Excel. It paginates Supabase results and includes the phone, brand, consent
version, and Tbilisi timestamp.

Required production environment variables:

- `CRON_SECRET`
- `RESEND_API_KEY`
- `REPORT_TO_EMAIL`
- `REPORT_FROM_EMAIL` (optional; defaults to Resend's test sender)
