-- Cluster objects and dev passwords belong to bootstrap, never migrations.
-- Runs only on an empty volume. E08 provisions production roles separately.
\set ON_ERROR_STOP on
\getenv migrate_pw CALFLEX_MIGRATE_PASSWORD
\getenv api_pw CALFLEX_API_PASSWORD
\getenv caldav_pw CALFLEX_CALDAV_PASSWORD
SELECT format('CREATE ROLE calflex_migrate LOGIN PASSWORD %L', :'migrate_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'calflex_migrate')\gexec
SELECT format('CREATE ROLE calflex_api LOGIN PASSWORD %L', :'api_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'calflex_api')\gexec
SELECT format('CREATE ROLE calflex_caldav LOGIN PASSWORD %L', :'caldav_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'calflex_caldav')\gexec
SELECT format('ALTER DATABASE %I OWNER TO calflex_migrate', current_database())\gexec
ALTER SCHEMA public OWNER TO calflex_migrate;
