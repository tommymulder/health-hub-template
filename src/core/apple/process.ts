import type { Sql } from "../db";
import { parseHaePayload, type AppleSample, type AppleWorkout } from "./parse";
import { SOURCE } from "./capture";
import { setState } from "../syncState";
import { inTx } from "../db";

export interface ProcessResult {
  samples: number;
  workouts: number;
  linked: number;
  droppedOura: number;
  skipped: Record<string, number>;
}

const CHUNK = 500;

export async function upsertSamples(sql: Sql, rows: AppleSample[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((r) => ({ ...r, extra: r.extra ? sql.json(r.extra as never) : null }));
    // Re-sending the same export rewrites the same rows (natural key). `hidden` is deliberately
    // NOT updated: a point you excluded stays excluded when the phone sends it again.
    await sql`
      insert into apple_samples ${sql(part, "metric", "start_at", "end_at", "source", "value", "min", "max", "unit", "extra")}
      on conflict (metric, start_at, source) do update set
        end_at = excluded.end_at, value = excluded.value, min = excluded.min, max = excluded.max,
        unit = excluded.unit, extra = excluded.extra`;
  }
}

export async function upsertWorkouts(sql: Sql, rows: AppleWorkout[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((r) => ({ ...r, data: sql.json(r.data as never) }));
    await sql`
      insert into apple_workouts ${sql(part, "id", "name", "start_at", "end_at", "source", "data")}
      on conflict (id) do update set
        name = excluded.name, start_at = excluded.start_at, end_at = excluded.end_at,
        source = excluded.source, data = excluded.data`;
  }
}

// Link an Apple workout to the Hevy workout it overlaps by at least half of the SHORTER one's length.
// (Hevy writes its workout to Apple Health when it is saved, so a workout logged later, like an
// after-the-fact class, will not overlap: it simply stays unlinked.)
export async function linkWorkouts(sql: Sql, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await sql`
    update apple_workouts a set linked_workout_id = (
      select w.id from workouts w
      where not w.deleted
        and least(w.end_at, a.end_at) - greatest(w.start_at, a.start_at) > interval '0'
        and (least(w.end_at, a.end_at) - greatest(w.start_at, a.start_at)) * 2
            >= least(w.end_at - w.start_at, a.end_at - a.start_at)
      order by least(w.end_at, a.end_at) - greatest(w.start_at, a.start_at) desc
      limit 1)
    where a.id = any(${ids})`;
  const [r] = await sql<{ n: string }[]>`select count(*) as n from apple_workouts where id = any(${ids}) and linked_workout_id is not null`;
  void res;
  return Number(r.n);
}

// Parse one stored raw body and write the clean rows. Safe to repeat (idempotent).
export async function processRaw(sql: Sql, rawId: number, timeZone: string): Promise<ProcessResult> {
  const [row] = await sql<{ payload: unknown }[]>`select payload from raw_ingest where id = ${rawId}`;
  if (!row) throw new Error(`raw_ingest ${rawId} not found`);
  const parsed = parseHaePayload(row.payload, timeZone);
  await upsertSamples(sql, parsed.samples);
  await upsertWorkouts(sql, parsed.workouts);
  const linked = await linkWorkouts(sql, parsed.workouts.map((w) => w.id));
  await sql`update raw_ingest set processed_at = now(), error = null where id = ${rawId}`;
  await setState(sql, SOURCE, { last_run_at: new Date(), last_ok_at: new Date(), last_error: null });
  return { samples: parsed.samples.length, workouts: parsed.workouts.length, linked, droppedOura: parsed.droppedOura, skipped: parsed.skipped };
}

// Process every stored body that has not been processed yet (or, after a parser fix, all of them).
// Bounded by a time budget so a big backlog finishes over several calls instead of timing out.
export async function processPending(sql: Sql, timeZone: string, opts: { all?: boolean; budgetMs?: number } = {}) {
  const started = Date.now(), budget = opts.budgetMs ?? 40_000;
  const ids = await sql<{ id: string }[]>`
    select id from raw_ingest where source = ${SOURCE} and (${!!opts.all} or processed_at is null) order by id`;
  const total: ProcessResult = { samples: 0, workouts: 0, linked: 0, droppedOura: 0, skipped: {} };
  let done = 0, failed = 0;
  for (const { id } of ids) {
    if (Date.now() - started > budget) break;
    try {
      const r = await inTx(sql, (tx) => processRaw(tx, Number(id), timeZone));
      total.samples += r.samples; total.workouts += r.workouts; total.linked += r.linked; total.droppedOura += r.droppedOura;
      for (const [k, n] of Object.entries(r.skipped)) total.skipped[k] = (total.skipped[k] ?? 0) + n;
      done++;
    } catch (err) {
      failed++;
      await sql`update raw_ingest set error = ${(err as Error).message.slice(0, 500)} where id = ${Number(id)}`;
    }
  }
  return { bodies_found: ids.length, processed: done, failed, remaining: ids.length - done - failed, ...total };
}
