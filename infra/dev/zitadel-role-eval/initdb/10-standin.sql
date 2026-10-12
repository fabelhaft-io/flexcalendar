-- --- E08-R10 harness: the sibling database that stands in for `caldav` ------
--
-- Postgres runs every file in /docker-entrypoint-initdb.d when the data volume
-- is empty. This one gives the throwaway cluster the same shape E04-R02's roles
-- have in the local stack: a database with its own owner and a table whose rows
-- Zitadel's runtime role must not be able to read.
--
-- Written to be re-runnable by hand, like infra/dev/postgres/initdb/.

\set ON_ERROR_STOP on

\getenv caldav_pw ZRE_CALDAV_PASSWORD

SELECT format('CREATE ROLE calflex_caldav LOGIN PASSWORD %L', :'caldav_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'calflex_caldav')\gexec

SELECT format('ALTER DATABASE %I OWNER TO calflex_caldav', current_database())\gexec

CREATE TABLE IF NOT EXISTS public.calendars (id int primary key, uid uuid);

INSERT INTO public.calendars (id, uid)
VALUES (1, '11111111-1111-4111-8111-111111111111')
ON CONFLICT DO NOTHING;
