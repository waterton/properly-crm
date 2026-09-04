-- Saved commercial Letters of Intent (LOI), one per client/deal. Variable inputs + section toggles
-- live in the data JSON; the legal boilerplate is fixed in the app, so wording never drifts.
-- Run once in the Supabase SQL editor, then deploy.

create table if not exists loi_letters (
  id         bigint primary key,
  contact_id bigint,
  name       text,
  data       jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table loi_letters enable row level security;
create policy "loi_letters authenticated" on loi_letters for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
