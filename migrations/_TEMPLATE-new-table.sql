-- ============================================================================
-- TEMPLATE for creating a new table in the `public` schema.
--
-- IMPORTANT (Supabase change, effective 2026-10-30):
--   Supabase no longer auto-grants Data API access to newly created public
--   tables. Any new table MUST include the GRANT statements below, or the app
--   (supabase-js / PostgREST) will get "permission denied" when it touches it.
--   Existing tables created before this date are unaffected.
--
-- Copy this block for every new table. Replace `your_table`. Keep the RLS
-- policy so only signed-in users can read/write their data.
--
-- Roles used by this app:
--   authenticated -> the app's logged-in user sessions (supabase-js + user JWT)
--   service_role  -> the serverless API endpoints (api/*.js, SUPA_SERVICE_KEY)
--   anon          -> NOT granted on purpose: unauthenticated access stays blocked
-- ============================================================================

create table if not exists public.your_table (
  id         bigint primary key,
  -- ... your columns ...
  data       jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Row-level security: only signed-in users.
alter table public.your_table enable row level security;
create policy "your_table authenticated" on public.your_table
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Data API grants (REQUIRED for tables created on/after 2026-10-30).
grant select, insert, update, delete on public.your_table to authenticated;
grant select, insert, update, delete on public.your_table to service_role;
