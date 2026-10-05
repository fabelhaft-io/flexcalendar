-- --- calendar-flex local stack: first start of the Postgres cluster ---------
--
-- Postgres runs every file in /docker-entrypoint-initdb.d once, when the data
-- volume is empty (infra/dev/compose.yaml mounts this directory read-only
-- there). Everything is written to be re-runnable by hand as well, so the
-- script stays honest after the volume exists.
--
-- One cluster holds every durable state (D-11): Zitadel's database, and the
-- CalDAV schema that E04 migrates into CALFLEX_POSTGRES_DB (created by the
-- entrypoint). One pgBackRest repository can therefore capture the whole stack.

\set ON_ERROR_STOP on

-- Zitadel's own database. The core's DSN points at it; `start-from-init`
-- creates the schema, never the database.
SELECT 'CREATE DATABASE zitadel'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zitadel')\gexec
