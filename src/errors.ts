/** Postgres codes are translated here, at the repository boundary. A lost race is never a 500. */

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const conflict = (code: string, m: string) => new AppError(409, code, m);
export const badRequest = (code: string, m: string) => new AppError(400, code, m);
export const notFound = (m = 'not found') => new AppError(404, 'NOT_FOUND', m);
export const forbidden = (m = 'forbidden') => new AppError(403, 'FORBIDDEN', m);
export const unauthorized = (m = 'unauthorized') => new AppError(401, 'UNAUTHORIZED', m);
export const unavailable = (code: string, m: string) => new AppError(503, code, m);

interface PgError { code?: string; constraint?: string; message?: string }

export function translatePgError(err: unknown): AppError | undefined {
  const e = err as PgError;
  if (!e || typeof e.code !== 'string') return undefined;

  switch (e.code) {
    case '23P01':
      return conflict('ROOM_UNAVAILABLE',
        'That room is already booked for an overlapping interval.');

    case 'ATR01':
      return conflict('ILLEGAL_TRANSITION', e.message ?? 'illegal state transition');

    case '40P01':
    case '40001':
      return conflict('CONTENTION', 'That slot is under contention. Retry.');

    case 'ATR02':
      return conflict('APPEND_ONLY', e.message ?? 'this table is append-only');

    case '23505':
      switch (e.constraint) {
        case 'one_live_charge_per_booking':
          return conflict('ALREADY_CHARGED', 'This booking already has a live charge.');
        case 'one_live_refund_per_booking':
          return conflict('ALREADY_REFUNDED', 'This booking already has a refund.');
        case 'webhook_events_charge_id_event_type_key':
          return conflict('DUPLICATE_WEBHOOK', 'This event has already been recorded.');
        default:
          return conflict('DUPLICATE', 'That record already exists.');
      }

    case '23514':
      return badRequest('CONSTRAINT_VIOLATED', `Rejected by ${e.constraint ?? 'a constraint'}.`);

    case '23503':
      return badRequest('UNKNOWN_REFERENCE', 'A referenced record does not exist.');

    default:
      return undefined;
  }
}