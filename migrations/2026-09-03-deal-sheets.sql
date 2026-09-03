-- Saved Seller Net Sheets, one per client (reopen / update / re-export). The whole sheet's inputs
-- live in the data JSON; the calculated figures are derived in the app, so nothing stale is stored.
-- Run once in the Supabase SQL editor, then deploy.

create table if not exists deal_sheets (
  id         bigint primary key,
  contact_id bigint,          -- -> contacts.id (the client this sheet is for; nullable)
  name       text,            -- a label, e.g. the property address or "Yolanda - 2459 W 1800 N"
  data       jsonb,           -- all editable inputs (seller, address, taxes, hoa, closing, scenarios[])
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table deal_sheets enable row level security;
create policy "deal_sheets authenticated" on deal_sheets for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
