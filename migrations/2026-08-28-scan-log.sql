-- A tiny heartbeat log so the app can show when the rental scan last ran (cron or button) and what
-- it did. Lets you glance at the Rental tab and know the automation is alive without leaving the app.
-- Run once in the Supabase SQL editor, then deploy.

create table if not exists inv_scan_log (
  id          bigint primary key,
  ran_at      timestamptz default now(),
  trigger     text,          -- auto (cron) | manual (button)
  added       int,
  skipped     int,
  unmatched   int,
  no_pdf      int,
  ok          boolean default true,
  note        text,
  created_at  timestamptz default now()
);

alter table inv_scan_log enable row level security;
create policy "inv_scan_log authenticated" on inv_scan_log for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
