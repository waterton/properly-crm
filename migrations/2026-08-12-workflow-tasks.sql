-- Templated transaction workflow — first slice.
-- Template steps (TC_TEMPLATES) can now carry a due-rule + owner and are "materialized" into
-- dated deadline records so they inherit reminders, the priority engine, and the client portal.
-- Each generated task links back to its template step (stepKey) and carries the responsible role
-- (owner). Both nullable; existing deadlines are unaffected.
-- Run in the Supabase SQL editor once, then deploy app.js + index.html.

alter table deadlines add column if not exists "stepKey" text;
alter table deadlines add column if not exists owner    text;
