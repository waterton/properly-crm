-- Investment / rental property tracking.
-- A "Properties" tab backed by four tables. Money lives in one ledger; properties, units, and HOA
-- accounts are the things money attaches to. IDs are app-generated bigints (Date.now()+random),
-- matching the rest of the CRM. Amounts are numeric for clean summing. RLS mirrors the app's
-- pattern (any authenticated user). Run once in the Supabase SQL editor, then deploy app.js + index.html.

create table if not exists inv_hoa (
  id            bigint primary key,
  name          text,
  account_number text,
  dues_amount   numeric,
  dues_frequency text,          -- monthly | quarterly | annual
  due_day       int,            -- day of month/period the dues are due
  notes         text,
  created_at    timestamptz default now()
);

create table if not exists inv_properties (
  id            bigint primary key,
  name          text,           -- friendly label e.g. "123 Main"
  address       text,
  hoa_id        bigint,         -- -> inv_hoa.id (nullable; several properties may share one)
  purchase_price numeric,
  purchase_date text,
  mortgage_lender text,
  mortgage_balance numeric,
  mortgage_payment numeric,     -- expected monthly P&I
  mortgage_due_day int,
  notes         text,
  created_at    timestamptz default now()
);

create table if not exists inv_units (
  id            bigint primary key,
  property_id   bigint,         -- -> inv_properties.id
  label         text,           -- "Whole home" | "Upstairs" | "Downstairs" | unit #
  rent_amount   numeric,        -- expected monthly rent
  rent_due_day  int,
  tenant_name   text,
  lease_start   text,
  lease_end     text,
  status        text,           -- occupied | vacant
  notes         text,
  created_at    timestamptz default now()
);

create table if not exists inv_ledger (
  id            bigint primary key,
  date          text,           -- YYYY-MM-DD of the transaction
  property_id   bigint,         -- -> inv_properties.id (nullable for portfolio-level items)
  unit_id       bigint,         -- -> inv_units.id (set for rent income)
  hoa_id        bigint,         -- -> inv_hoa.id (set for HOA dues)
  direction     text,           -- income | expense
  category      text,           -- Rent | Mortgage | HOA | Utilities | Insurance | Property Tax | Repairs | Management | Other
  amount        numeric,
  payee         text,
  method        text,           -- optional (check, ACH, card, ...)
  source        text,           -- manual | email | csv
  email_ref     text,           -- Gmail message id when source=email (dedupe)
  notes         text,
  created_at    timestamptz default now()
);

-- Dedupe guard so re-scanning the same email can't double-post the same charge.
create unique index if not exists inv_ledger_email_ref_uidx
  on inv_ledger (email_ref) where email_ref is not null;

-- RLS: any authenticated user (same model as the rest of the CRM).
alter table inv_hoa        enable row level security;
alter table inv_properties enable row level security;
alter table inv_units      enable row level security;
alter table inv_ledger     enable row level security;

create policy "inv_hoa authenticated"        on inv_hoa        for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "inv_properties authenticated" on inv_properties for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "inv_units authenticated"      on inv_units      for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "inv_ledger authenticated"     on inv_ledger     for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
