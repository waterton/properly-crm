-- Commercial Search: candidate commercial properties scouted for a client (tenant/buyer rep).
-- A shortlist you capture fast in the field and enrich with due diligence later (zoning, NNN/CAM,
-- $/SF/yr, etc.), grouped per client and exportable to a PDF you send them. All editable fields live
-- in the data JSON so the shape can evolve without migrations. Run once, then deploy.

create table if not exists commercial_prospects (
  id         bigint primary key,
  contact_id bigint,            -- -> contacts.id (the client this property is being scouted for)
  name       text,              -- label, usually the address
  data       jsonb,             -- address, status, use/zoning, rentable SF, $/SF/yr, NNN/CAM, notes...
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table commercial_prospects enable row level security;
create policy "commercial_prospects authenticated" on commercial_prospects
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
