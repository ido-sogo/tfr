-- Run once after applying supabase-schema.sql.
-- This removes administrator assignments granted before password verification existed.
begin;

delete from public.traffic_report_admins;

commit;
