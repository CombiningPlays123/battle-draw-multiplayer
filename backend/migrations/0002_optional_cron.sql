-- Optional: scheduled clean-up of abandoned rooms every 15 minutes.
-- Requires the pg_cron extension (Dashboard -> Database -> Extensions -> pg_cron).
-- Rooms are also cleaned lazily whenever someone creates a room, so this is only a tidy-up.
create extension if not exists pg_cron;
select cron.unschedule('bdmp-cleanup') where exists (select 1 from cron.job where jobname = 'bdmp-cleanup');
select cron.schedule('bdmp-cleanup', '*/15 * * * *', $$ select public._cleanup_rooms() $$);
