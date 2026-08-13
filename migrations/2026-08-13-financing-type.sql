-- Seller-financing awareness.
-- Deals can be bank-financed (conventional/FHA/VA), cash, or seller-financed (owner carry). The
-- risk engine and workflow previously assumed a bank loan, so seller-financed / cash deals got
-- false "missing financing/appraisal deadline" alarms. This adds a financingType so the app can
-- apply the right rules. The seller-financing note terms (amount, rate, term, balloon, payment,
-- etc.) are stored in the existing transactions.details jsonb under a "sf" key — no new columns
-- needed for those. Nullable; existing deals are unaffected (blank = treat as bank-financed).
-- Run in the Supabase SQL editor once, then deploy app.js + index.html.

alter table transactions add column if not exists "financingType" text;
