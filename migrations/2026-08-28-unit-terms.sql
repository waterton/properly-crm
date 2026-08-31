-- Editable per-unit financial terms, so rent/fee/pass-through changes are DATA, never code.
-- Rent already lives on inv_units (rent_amount). This adds the management fee and any pass-through
-- (e.g. Murray's $75 parking that we collect with rent and hand straight to the HOA). The app derives
-- the "expected" figures from these fields; nothing about dollar amounts is hardcoded.
--
--   expected deposit = rent_amount - mgmt_fee + passthrough_amount
--   expected profit  = rent_amount - mgmt_fee          (pass-through washes: +income, -HOA)
--
-- Run once in the Supabase SQL editor, then deploy app.js + index.html.

alter table inv_units add column if not exists mgmt_fee           numeric;  -- monthly management fee (expense)
alter table inv_units add column if not exists passthrough_amount numeric;  -- collected with rent, paid straight to HOA (nets to zero profit)
alter table inv_units add column if not exists passthrough_label  text;     -- what the pass-through is, e.g. "Parking"
