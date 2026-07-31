-- Contract intelligence: keep each scan's full extraction on the document row.
-- Powers cross-document discrepancy checks and the AI advisory layer in Risk Review.
-- Run in the Supabase SQL editor once, then deploy app.js.

alter table documents add column if not exists extracted jsonb;
