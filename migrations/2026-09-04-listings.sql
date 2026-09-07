-- Canonical listing records (property-as-marketing-asset). One entry -> site post, social, drips.
-- v1 mirrors the loi_letters/deal_sheets pattern: all editable fields live in the `data` JSON so the
-- shape can evolve without migrations while we see how it works. Explicit columns can be promoted
-- later (see docs/listing-schema.md §8). Run once in the Supabase SQL editor, then deploy.

create table if not exists listings (
  id         bigint primary key,
  contact_id bigint,            -- -> contacts.id (the seller; nullable)
  name       text,              -- label, e.g. "2459 W 1800 N, Clinton"
  data       jsonb,             -- all fields: address, price, status, property_type, details,
                                --   headline/pitch EN+ES, features, photo links, outputs, archived...
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table listings enable row level security;
create policy "listings authenticated" on listings
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
