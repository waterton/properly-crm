-- Notes tab upgrade: categories + persisted Spanish translation
-- Run this in the Supabase SQL editor once, then deploy app.js + index.html.
--
-- category : General | Call | Meeting | Document  (defaults to General)
-- "textEs" : Spanish version of the note (from the scanner's spanishSummary).
--            Quoted to preserve camelCase, matching the app's field name.

alter table notes add column if not exists category text default 'General';
alter table notes add column if not exists "textEs" text;

-- Backfill: existing scan notes -> Document, everything else -> General
update notes set category = 'Document'
  where category is null and text like 'Document scanned:%';
update notes set category = 'General'
  where category is null;
