-- 008  Append-only that holds whichever role is connected.
--
-- 006 revokes UPDATE and DELETE from atrium_app, which is correct and is the
-- mechanism intended for production. It has one hole: an owner cannot be
-- revoked from its own tables, so if the application connects as the owner --
-- which it does in docker compose and on the free hosting tier, where creating
-- a second role is not always possible -- the revoke protects nothing.
--
-- These triggers do not care who is connected. Belt and braces, and the belt
-- is the one that is actually fastened in the demo.

CREATE FUNCTION reject_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'ATR02';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Policy versions are immutable; an edit inserts a new version (4B).
CREATE TRIGGER refund_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON refund_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- The transition matrix is not application data.
CREATE TRIGGER booking_transitions_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON booking_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
