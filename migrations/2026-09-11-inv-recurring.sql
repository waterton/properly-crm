-- Recurring monthly investment expenses/income templates. Each active template drops one entry into
-- inv_ledger per month: FIXED items (variable=false, e.g. a mortgage payment) post automatically as a
-- real amount; VARIABLE items (variable=true, e.g. a city utility bill) do NOT post a number — they
-- surface a "confirm this month's amount" prompt so the ledger only ever holds real figures.
-- Run once in the Supabase SQL editor, then deploy.

create table if not exists inv_recurring (
  id           bigint primary key,
  property_id  bigint,          -- -> inv_properties.id (nullable)
  unit_id      bigint,          -- -> inv_units.id (nullable; for per-unit rent)
  category     text,            -- Mortgage / Utilities / HOA / Rent / ... (drives income vs expense)
  payee        text,
  amount       numeric,         -- the fixed amount, or the usual/estimated amount for a variable bill
  day_of_month int,             -- day the entry is dated each month (clamped to the month length)
  variable     boolean default false,  -- true = amount changes monthly -> confirm before it counts
  active       boolean default true,
  notes        text,
  created_at   timestamptz default now()
);

alter table inv_recurring enable row level security;
create policy "inv_recurring authenticated" on inv_recurring
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
