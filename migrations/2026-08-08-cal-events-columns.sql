-- Calendar events never fully synced to the cloud: the cal_events table was missing columns the
-- app writes (contactId, memberId, endTime, type, ...). Events lived only in localStorage.
-- This adds every field the app stores so calendar events sync across devices.
-- Run in the Supabase SQL editor once, then deploy app.js.

alter table cal_events add column if not exists title      text;
alter table cal_events add column if not exists "date"     text;
alter table cal_events add column if not exists "time"     text;
alter table cal_events add column if not exists "endTime"  text;
alter table cal_events add column if not exists type       text;
alter table cal_events add column if not exists "memberId" bigint;
alter table cal_events add column if not exists "contactId" bigint;
alter table cal_events add column if not exists notes      text;
