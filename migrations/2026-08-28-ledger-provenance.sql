-- Ledger provenance & dating, so every non-manual row is traceable to a real email and utility
-- bills carry both the day we received them and the day they're due.
--
--   message_id    - the source Gmail message-id (traceability + the "must be backed by an email"
--                   cleanup rule). NOT unique: one Fresh Start email splits into several rows.
--   received_date - the date the email arrived (when the row was really observed).
--   due_date      - the bill's due date (utilities), shown as a "Due <date>" badge.
--
-- Dedupe still rides on the existing UNIQUE index on email_ref. For a single-charge email the
-- dedupe key is the message-id; for a multi-row statement it's message-id + a per-row slot, so the
-- same email can't double-post yet its several rows coexist.
--
-- Run once in the Supabase SQL editor, then deploy.

alter table inv_ledger add column if not exists message_id    text;
alter table inv_ledger add column if not exists received_date text;
alter table inv_ledger add column if not exists due_date      text;

create index if not exists inv_ledger_message_id_idx on inv_ledger (message_id) where message_id is not null;
