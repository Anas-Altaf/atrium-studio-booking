-- 009  Closing the hole 008 left open: TRUNCATE.
--
-- 008 rejects UPDATE and DELETE on the append-only tables with row-level
-- triggers. TRUNCATE removes rows without producing any row events, so a
-- BEFORE UPDATE OR DELETE ... FOR EACH ROW trigger never fires for it. The
-- audit trail could therefore be erased in one statement by exactly the role
-- the triggers were written to constrain. Recorded as a known defect in the
-- README and now closed.
--
-- Statement-level, because there are no rows to iterate. A cascaded truncate
-- fires the trigger on the cascaded table too, so TRUNCATE bookings CASCADE is
-- refused for the same reason as TRUNCATE audit_events.

CREATE FUNCTION reject_truncate() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE is not permitted', TG_TABLE_NAME
    USING ERRCODE = 'ATR02',
          HINT = 'the seed disables this guard explicitly, which requires table ownership';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER refund_policy_versions_no_truncate
  BEFORE TRUNCATE ON refund_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE TRIGGER booking_transitions_no_truncate
  BEFORE TRUNCATE ON booking_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- The seed is the one legitimate caller, and it resets the database wholesale.
-- It disables these triggers for the length of its transaction, which requires
-- ownership of the table -- a privilege atrium_app does not hold under 006.
-- Seeding is a migrator-role operation, and this is what makes that true rather
-- than merely stated.
