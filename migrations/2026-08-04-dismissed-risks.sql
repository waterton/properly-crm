-- Risk Review: let a user mark a flag "reviewed" so it stops firing.
-- Stores an array of dismissed flag keys per transaction (stable, wording-independent ids).
-- Run in the Supabase SQL editor once, then deploy app.js + api/cron-briefing.js.

alter table transactions add column if not exists "dismissedRisks" jsonb;
