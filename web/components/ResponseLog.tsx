"use client";

export interface LogLine {
  id: number;
  label: string;
  status: number;
  code: string | null;
  message: string | null;
  correlationId: string | null;
  ms: number;
}

const tone = (status: number) => {
  if (status === 0) return "text-amber-700 dark:text-amber-400";
  if (status >= 500) return "text-red-700 dark:text-red-400";
  if (status === 409) return "text-orange-700 dark:text-orange-400";
  if (status >= 400) return "text-yellow-700 dark:text-yellow-500";
  return "text-emerald-700 dark:text-emerald-400";
};

/**
 * Every call the page makes, with the status, the API's own error code and the
 * correlation id. The id is what ties a refusal here to a line in the server
 * log, which is the point of having one.
 */
export default function ResponseLog({ lines }: { lines: LogLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="text-sm opacity-60">
        No requests yet. Every call made from this page shows up here.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2 font-mono text-xs">
      {lines.map((l) => (
        <li
          key={l.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-black/5 pb-2 last:border-0 dark:border-white/10"
        >
          <span className={`font-semibold tabular-nums ${tone(l.status)}`}>
            {l.status === 0 ? "ERR" : l.status}
          </span>
          <span className="opacity-80">{l.label}</span>
          {l.code && <span className={tone(l.status)}>{l.code}</span>}
          <span className="ml-auto tabular-nums opacity-50">{l.ms}ms</span>
          {l.message && (
            <span className="w-full opacity-70">{l.message}</span>
          )}
          {l.correlationId && (
            <span className="w-full opacity-40">
              correlation-id {l.correlationId}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
