// How each Oura collection maps onto the generic oura_documents table (DESIGN section 5).
export interface CollectionSpec {
  name: string;
  day: (d: Record<string, unknown>) => string | null;
  start?: (d: Record<string, unknown>) => string | null;
  end?: (d: Record<string, unknown>) => string | null;
}

// Oura local timestamps carry an offset ("2026-10-10T09:19:03.000-07:00"); anything without one is ambiguous, so skip it.
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !/(Z|[+-]\d\d:?\d\d)$/i.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
const str = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

const daily = (name: string): CollectionSpec => ({ name, day: (d) => str(d.day) });
const period = (name: string, startKey: string, endKey: string, dayKey = "day"): CollectionSpec => ({
  name, day: (d) => str(d[dayKey]), start: (d) => isoOrNull(d[startKey]), end: (d) => isoOrNull(d[endKey]),
});

export const COLLECTIONS: CollectionSpec[] = [
  daily("daily_readiness"),
  daily("daily_sleep"),
  daily("daily_activity"),
  daily("daily_spo2"),
  daily("daily_stress"),
  daily("daily_resilience"),
  daily("daily_cardiovascular_age"),
  daily("vO2_max"),
  daily("sleep_time"),
  period("sleep", "bedtime_start", "bedtime_end"),
  period("workout", "start_datetime", "end_datetime"),
  period("session", "start_datetime", "end_datetime"),
  period("enhanced_tag", "start_time", "end_time", "start_day"),
  period("rest_mode_period", "start_time", "end_time", "start_day"),
];

export const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name);

// What the read tools actually use (get_recovery, get_trends, get_oura_data's common asks, get_workout_details'
// heart rate). A read tool refreshes only these before answering; the daily cron and sync_now fetch everything.
export const QUICK_REFRESH = ["daily_readiness", "daily_sleep", "daily_activity", "daily_stress", "daily_spo2", "sleep", "workout", "heartrate"] as const;
