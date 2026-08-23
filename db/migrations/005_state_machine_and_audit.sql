-- 005  Append-only audit, the transition matrix, and the trigger that enforces it.
--
-- "UPDATE bookings SET status = ?" scattered across controllers is called a fail
-- in the brief. Enforcing the matrix in a BEFORE UPDATE trigger makes "exactly
-- one AuditEvent per transition" structurally true rather than conventionally
-- true: no code path can change state without being validated and audited.

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  booking_id  uuid           NOT NULL REFERENCES bookings(id),
  actor_id    uuid           REFERENCES users(id),   -- NULL = system (reaper, worker)
  from_state  booking_status,
  to_state    booking_status NOT NULL,
  reason      text           NOT NULL,
  occurred_at timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_booking_idx ON audit_events (booking_id, occurred_at);

-- The matrix is data, not a CASE statement, so it can be read and tested
-- directly. Any pair absent from this table is illegal. See ARCHITECTURE.md 2.
CREATE TABLE booking_transitions (
  from_state booking_status NOT NULL,
  to_state   booking_status NOT NULL,
  note       text           NOT NULL,
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO booking_transitions (from_state, to_state, note) VALUES
  ('DRAFT',           'HELD',            'inventory reserved'),
  ('DRAFT',           'EXPIRED',         'abandoned before hold'),
  ('HELD',            'HELD',            'checkout re-issues TTL (A1)'),
  ('HELD',            'PENDING_PAYMENT', 'charge submitted'),
  ('HELD',            'EXPIRED',         'TTL elapsed, reaper'),
  ('HELD',            'CANCELLED',       'released by customer'),
  ('PENDING_PAYMENT', 'CONFIRMED',       'capture confirmed, hold still live'),
  ('PENDING_PAYMENT', 'FAILED',          'charge declined'),
  ('PENDING_PAYMENT', 'EXPIRED',         'TTL elapsed while outcome unknown'),
  ('CONFIRMED',       'COMPLETED',       'end_at passed'),
  ('CONFIRMED',       'CANCELLED',       'cancelled by customer or staff'),
  ('CANCELLED',       'REFUNDED',        'refund captured back'),
  ('EXPIRED',         'REFUNDED',        'late capture returned (INV-4)');

CREATE FUNCTION enforce_booking_transition() RETURNS trigger AS $fn$
DECLARE
  v_actor  uuid;
  v_reason text;
BEGIN
  -- A HELD row whose expires_at moves is the checkout re-issue of A1. It is a
  -- HELD -> HELD transition and is audited like any other.
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'HELD' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
  THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM booking_transitions t
    WHERE t.from_state = OLD.status AND t.to_state = NEW.status
  ) THEN
    -- Caught at the repository boundary and mapped to 409, never a 500.
    RAISE EXCEPTION 'illegal booking transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'ATR01';
  END IF;

  -- Transaction-scoped, set with SET LOCAL by the repository. This is the same
  -- session-variable mechanism rejected for row-level security in 4A, and it is
  -- acceptable here for a reason worth stating: a variable leaking across a
  -- pooled connection would put a wrong actor on an audit row, which is a data
  -- quality fault. In RLS the same leak decides what a caller may read, which
  -- is an isolation breach. SET LOCAL confines it to the transaction either way.
  v_actor  := NULLIF(current_setting('atrium.actor_id', true), '')::uuid;
  v_reason := COALESCE(NULLIF(current_setting('atrium.reason', true), ''), 'unspecified');

  INSERT INTO audit_events (booking_id, actor_id, from_state, to_state, reason)
  VALUES (NEW.id, v_actor, OLD.status, NEW.status, v_reason);

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER booking_transition_guard
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_transition();

-- The insert side: a booking is created in DRAFT or HELD and that origin is
-- audited too, so every row in bookings has a complete history.
CREATE FUNCTION audit_booking_insert() RETURNS trigger AS $fn$
BEGIN
  INSERT INTO audit_events (booking_id, actor_id, from_state, to_state, reason)
  VALUES (NEW.id,
          NULLIF(current_setting('atrium.actor_id', true), '')::uuid,
          NULL, NEW.status,
          COALESCE(NULLIF(current_setting('atrium.reason', true), ''), 'created'));
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER booking_insert_audit
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION audit_booking_insert();
