-- --- E08-R10 harness: the role and database the bootstrap creates -----------
--
-- This is option B's "pre-provisioned role and no admin at all", written like
-- infra/dev/postgres/initdb/20-roles.sql: the cluster bootstrap creates the
-- database and a role that owns it, so Zitadel never needs a login that can
-- create databases or roles.
--
-- It is guarded by ZRE_PREPROVISION so that one mounted directory serves every
-- option: option A lets `zitadel init` create the database, option C runs as the
-- superuser, and both set ZRE_PREPROVISION=false.
--
-- Runs only on an empty volume, and is re-runnable by hand.

\set ON_ERROR_STOP on

\getenv preprovision ZRE_PREPROVISION

\if :preprovision

\getenv zitadel_pw ZRE_ZITADEL_PASSWORD

SELECT format('CREATE ROLE calflex_zitadel LOGIN PASSWORD %L', :'zitadel_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'calflex_zitadel')\gexec

-- Zitadel owns its database: it creates its schemas during `init`, and needs
-- nothing beyond it.
SELECT 'CREATE DATABASE zitadel OWNER calflex_zitadel'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zitadel')\gexec

\else

\echo 'E08-R10 harness: pre-provisioning skipped (ZRE_PREPROVISION is not true)'

\endif
