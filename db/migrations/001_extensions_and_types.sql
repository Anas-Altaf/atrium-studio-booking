-- 001  Extensions and enum types.
--
-- btree_gist lets a GiST index mix a scalar equality column (room_id) with a
-- range overlap column (reserved_range) in the same exclusion constraint.
-- Without it, room_id WITH = cannot participate.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM (
  'CUSTOMER', 'VENUE_STAFF', 'VENUE_ADMIN', 'PLATFORM_ADMIN'
);

CREATE TYPE booking_status AS ENUM (
  'DRAFT', 'HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED',
  'EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED'
);

CREATE TYPE payment_status AS ENUM ('PENDING', 'CAPTURED', 'FAILED');

CREATE TYPE refund_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
