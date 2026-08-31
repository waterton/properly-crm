-- Approved payees / senders — the expense whitelist as editable DATA, so the scanner only books
-- money from sources you've approved (property managers, HOAs, utilities, tax authority) and never
-- from personal receipts (Amazon, Google Play, Suno, ...). Add/edit these in the app; no code change.
--
--   name        - friendly label, e.g. "Rocky Mountain Power"
--   match       - lowercased substring tested against the email's From + body, e.g.
--                 "rockymountainpower" or "@freshstartmgmt.com". A match makes the email eligible.
--   category    - default ledger category for this payee (Utilities | HOA | Property Tax |
--                 Management | Insurance | Mortgage | Other).
--   kind        - 'expense' (money we pay) or 'rent' (the manager that deposits rent to us).
--   property_id - optional: pin this payee's rows to one property.
--   active      - uncheck to pause without deleting.
--
-- Run once in the Supabase SQL editor, then deploy.

create table if not exists inv_payees (
  id           bigint primary key,
  name         text,
  match        text,
  category     text,
  kind         text,
  property_id  bigint,
  active       boolean default true,
  notes        text,
  created_at   timestamptz default now()
);

alter table inv_payees enable row level security;
create policy "inv_payees authenticated" on inv_payees for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
