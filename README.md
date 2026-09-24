# Number

Mobile-first Magniti SMS consent page, matched to the supplied 393 × 852 reference.

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

`SUPABASE_SECRET_KEY` must only exist in Vercel's encrypted environment-variable
store. Never put it in browser code, source control, chat, email, or screenshots.
