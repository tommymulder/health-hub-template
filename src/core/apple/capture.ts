import type { Sql } from "../db";
import { setState } from "../syncState";

// Capture mode (DESIGN 4.3, step 1): store exactly what Health Auto Export sent,
// parse nothing. We have never seen a real payload, so the parser is written
// against a real one (as fixtures), not against a guess.
export const RAW_KEEP_DAYS = 30;
export const SOURCE = "apple_health";

export interface CaptureResult {
  id: number;
  bytes: number;
  metrics: string[]; // metric names only, never values
  workouts: number;
}

// Names and counts only (safe to log and return; no health values).
export function describePayload(payload: unknown): { metrics: string[]; workouts: number } {
  const data = (payload as { data?: { metrics?: unknown; workouts?: unknown } } | null)?.data;
  const metrics = Array.isArray(data?.metrics)
    ? (data.metrics as { name?: unknown }[]).map((m) => String(m?.name ?? "?"))
    : [];
  const workouts = Array.isArray(data?.workouts) ? data.workouts.length : 0;
  return { metrics, workouts };
}

// Only these request headers are stored (HAE describes how it built the payload in them).
// An allowlist, so the ingest key can never end up in the database.
export const KEEP_HEADERS = ["automation-name", "automation-id", "automation-aggregation", "automation-period", "session-id", "content-type", "user-agent"];
export function pickHeaders(h: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP_HEADERS) { const v = h.get(k); if (v) out[k] = v.slice(0, 200); }
  return out;
}

export async function captureIngest(sql: Sql, payload: unknown, bytes: number, now = new Date(), headers: Record<string, string> = {}): Promise<CaptureResult> {
  const [row] = await sql<{ id: string }[]>`
    insert into raw_ingest (source, payload, received_at, headers)
    values (${SOURCE}, ${sql.json(payload as never)}, ${now}, ${sql.json(headers)}) returning id`;
  // Housekeeping: raw bodies are big, so old ones go (the cleaned rows stay).
  await sql`delete from raw_ingest where source = ${SOURCE} and received_at < ${new Date(now.getTime() - RAW_KEEP_DAYS * 86_400_000)}`;
  await setState(sql, SOURCE, { last_run_at: now, last_ok_at: now, last_error: null });
  return { id: Number(row.id), bytes, ...describePayload(payload) };
}
