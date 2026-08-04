-- Commercial lease support: give transactions a type category and a flexible details store.
-- category : 'residential' (default/implied for old rows) | 'commercial_lease' | 'commercial_purchase'
-- details  : jsonb bag of type-specific fields (lease terms, CAM, rent basis, etc.) so we don't
--            add a column per commercial field.
-- Run in the Supabase SQL editor once, then deploy app.js.

alter table transactions add column if not exists category text;
alter table transactions add column if not exists details jsonb;
