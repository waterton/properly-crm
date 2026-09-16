-- New Construction watch: builder communities/pricing/incentives, populated from builder agent emails
-- you subscribe to (parsed by the email scanner) or entered by hand. Ethical by design: the data comes
-- from emails the builders send you, not from scraping their sites. All editable fields live in the
-- data JSON. The builder-sender list lives in the settings table (key 'nc_builders'). Run once, then deploy.

create table if not exists nc_communities (
  id         bigint primary key,
  builder    text,              -- builder name (Edge, Fieldstone, Ivory, ...)
  name       text,              -- community name
  data       jsonb,             -- city, home types, price range, incentive, status, url, source, notes...
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table nc_communities enable row level security;
create policy "nc_communities authenticated" on nc_communities
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
