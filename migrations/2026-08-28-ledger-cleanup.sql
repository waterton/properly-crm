-- One-time rental ledger cleanup: remove machine-generated rows that aren't traceable to a real
-- email, so "actual" reflects only real money movement. STAGED ON PURPOSE - run the review query
-- first and look at what you have before deleting anything. Nothing here touches manual entries.
--
-- Provenance model after the ingestion rewrite:
--   source='email'     + message_id  -> trustworthy (real email / PDF statement)   KEEP
--   source='manual'                  -> you typed it                                KEEP
--   source='csv'                     -> your one-time CSV backfill                  KEEP by default
--   source='recurring'               -> old auto-posted phantom mortgage            DELETE
--   source='auto'                    -> old content-keyed scanner (no message_id)   DELETE
--   source is null / email w/o msgid -> legacy, untraceable                         DELETE (optional)

-- 1) REVIEW FIRST — what exists, grouped by source, and how many lack a message-id.
select source,
       count(*)                                            as rows,
       count(*) filter (where message_id is null)          as no_message_id,
       round(sum(amount)::numeric, 2)                      as total_amount
from inv_ledger
group by source
order by source;

-- 1b) The exact rows that the deletes below would remove (eyeball before running step 2/3):
-- select id, date, category, amount, payee, source, message_id, notes
-- from inv_ledger
-- where source in ('recurring','auto')
--    or (source is null)
--    or (source = 'email' and message_id is null)
-- order by date desc;

-- 2) DELETE the clearly-synthetic machine rows (phantom mortgage + old scanner output).
delete from inv_ledger where source in ('recurring', 'auto');

-- 3) OPTIONAL — also remove legacy/untraceable rows (null source, or old 'email' rows that predate
--    message-id provenance). Uncomment only after confirming step 1b looks right.
-- delete from inv_ledger
-- where source is null
--    or (source = 'email' and message_id is null);

-- Note: 'csv' and 'manual' rows are intentionally left in place. If your CSV backfill duplicates
-- what the new pipeline now derives from statements, delete those rows in the app (or add
--   -- delete from inv_ledger where source = 'csv';
-- here) once you've confirmed the statement-derived rows are correct.
