-- 004  Payments, refunds, and webhook intake.

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid           NOT NULL REFERENCES bookings(id),
  charge_id       text,                       -- NULL until Paygate returns 202
  -- Derived from the payment attempt and persisted before the outbound call,
  -- so a 500 from POST /charges is retried with the same key.
  idempotency_key uuid           NOT NULL UNIQUE,
  status          payment_status NOT NULL DEFAULT 'PENDING',
  amount_minor    bigint         NOT NULL CHECK (amount_minor > 0),
  currency        text           NOT NULL DEFAULT 'PKR',
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

-- INV-3, at the database level: at most one live charge per booking.
CREATE UNIQUE INDEX one_live_charge_per_booking
  ON payments (booking_id) WHERE status IN ('PENDING', 'CAPTURED');

CREATE UNIQUE INDEX payments_charge_id_uq
  ON payments (charge_id) WHERE charge_id IS NOT NULL;

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid          NOT NULL REFERENCES bookings(id),
  payment_id         uuid          NOT NULL REFERENCES payments(id),
  amount_minor       bigint        NOT NULL CHECK (amount_minor >= 0),
  status             refund_status NOT NULL DEFAULT 'PENDING',
  reason             text          NOT NULL,
  idempotency_key    uuid          NOT NULL UNIQUE,
  provider_refund_id text,
  attempts           int           NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz   NOT NULL DEFAULT now(),
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

-- Double-clicking cancel refunds once. The state machine already prevents the
-- second cancellation; this is the second line of defence. See 4C.
CREATE UNIQUE INDEX one_live_refund_per_booking
  ON refunds (booking_id) WHERE status IN ('PENDING', 'SUCCEEDED');

-- Deduplication is on the business event. X-Paygate-Delivery is new on every
-- delivery attempt by specification and is useless as a dedup key; it is stored
-- for tracing only.
CREATE TABLE webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       text        NOT NULL,
  event_type      text        NOT NULL,
  delivery_id     uuid,
  payload         jsonb       NOT NULL,
  correlation_id  text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int         NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  UNIQUE (charge_id, event_type)
);

-- 25% of deliveries race ahead of the 202, so an unknown charge is an expected
-- condition, not an error. Persisted, answered 200, resolved by a sweeper.
CREATE TABLE unmatched_webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id   text        NOT NULL,
  payload     jsonb       NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
