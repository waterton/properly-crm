-- Document completeness checker: store per-transaction manual overrides (mark present / N/A)
-- for the required-document checklist. Auto-detection comes from scanned doc types; this column
-- only holds the user's manual marks so they persist.
-- Run in the Supabase SQL editor once, then deploy app.js.

alter table transactions add column if not exists "docChecklist" jsonb;
