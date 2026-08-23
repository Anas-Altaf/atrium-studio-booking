-- 006  Append-only enforced by privilege, not by convention.
--
-- The application connects as atrium_app, which is not the owner of these
-- tables. An owner can always update its own tables, so revoking from the
-- owner would achieve nothing; the separation of roles is what makes this real.
--
-- Run by the migrator role. atrium_app is created by scripts/setup-db.sh with a
-- password from the environment.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atrium_app') THEN
    CREATE ROLE atrium_app LOGIN;
  END IF;
END
$do$;

GRANT USAGE ON SCHEMA public TO atrium_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO atrium_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO atrium_app;

-- AuditEvent: append only. Never updated, never deleted.
REVOKE UPDATE, DELETE ON audit_events FROM atrium_app;

-- Policy versions are immutable; an edit inserts a new version (4B).
REVOKE UPDATE, DELETE ON refund_policy_versions FROM atrium_app;

-- The transition matrix is not application data.
REVOKE INSERT, UPDATE, DELETE ON booking_transitions FROM atrium_app;
