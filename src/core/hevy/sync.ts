import { inTx, type Sql } from "../db";
import { getState, setState } from "../syncState";
import { parseTemplate, parseWorkout } from "./parse";
import type { HevyApi, HevyEvent, HevyWorkout } from "./types";

export interface SyncDeps {
  sql: Sql;
  hevy: HevyApi | null; // null = Hevy is not set up (no HEVY_API_KEY): every Hevy sync is skipped
  timezone: string;
  now?: () => Date;
  budgetMs?: number; // stop starting new pages after this long
}

export interface SyncResult {
  source: string;
  ok: boolean;
  mode?: "backfill" | "incremental";
  workoutsUpserted?: number;
  workoutsDeleted?: number;
  templatesUpserted?: number;
  templatesPruned?: number;
  skipped?: string;
  complete?: boolean;
  error?: string;
}

const DEFAULT_BUDGET_MS = 45_000;

// ---- writing workouts -------------------------------------------------------

// Idempotent upsert, all-or-nothing: insert-or-update the workout, then replace
// its exercises and sets. Running it twice with the same input changes nothing.
export async function upsertWorkout(
  sql: Sql,
  w: HevyWorkout,
  timeZone: string,
  localTimeBatches: ReadonlySet<string> = new Set(),
): Promise<void> {
  const { workout, exercises } = parseWorkout(w, timeZone, localTimeBatches);
  await inTx(sql, async (tx) => {
    await tx`
      insert into workouts (id, title, description, start_at, end_at, local_date, hevy_updated_at, raw, deleted)
      values (${workout.id}, ${workout.title}, ${workout.description}, ${workout.start_at},
              ${workout.end_at}, ${workout.local_date}, ${workout.hevy_updated_at},
              ${tx.json(w as never)}, false)
      on conflict (id) do update set
        title = excluded.title, description = excluded.description,
        start_at = excluded.start_at, end_at = excluded.end_at,
        local_date = excluded.local_date, hevy_updated_at = excluded.hevy_updated_at,
        raw = excluded.raw, deleted = false`;

    await tx`delete from workout_exercises where workout_id = ${workout.id}`; // cascades to sets
    if (exercises.length === 0) return;

    const inserted = await tx<{ id: string; position: number }[]>`
      insert into workout_exercises ${tx(
        exercises.map((e) => ({
          workout_id: workout.id,
          position: e.position,
          exercise_template_id: e.exercise_template_id,
          exercise_title: e.exercise_title,
          superset_id: e.superset_id,
          notes: e.notes,
        })),
      )}
      returning id, position`;
    const idByPosition = new Map(inserted.map((r) => [r.position, r.id]));

    const setRows = exercises.flatMap((e) =>
      e.sets.map((s) => ({
        workout_exercise_id: idByPosition.get(e.position)!,
        position: s.position,
        set_type: s.set_type,
        weight_kg: s.weight_kg,
        reps: s.reps,
        rpe: s.rpe,
        duration_s: s.duration_s,
        distance_m: s.distance_m,
      })),
    );
    if (setRows.length > 0) await tx`insert into sets ${tx(setRows)}`;
  });
}

export async function loadLocalTimeBatches(sql: Sql): Promise<Set<string>> {
  const [row] = await sql<{ value: string }[]>`select value from settings where key = 'hevy_local_time_batches'`;
  if (!row) return new Set();
  const parsed: unknown = JSON.parse(row.value);
  return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
}

export async function markWorkoutDeleted(sql: Sql, id: string): Promise<void> {
  await sql`update workouts set deleted = true where id = ${id}`;
}

// ---- workouts: backfill + incremental --------------------------------------

export async function syncHevyWorkouts(deps: SyncDeps): Promise<SyncResult> {
  const { sql, hevy, timezone } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now();
  const deadline = started.getTime() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const timeLeft = () => now().getTime() < deadline;
  const SRC = "hevy_workouts";
  const BACKFILL = "hevy_backfill";
  if (!hevy) return { source: SRC, ok: true, skipped: "Hevy is not set up (no HEVY_API_KEY)" };

  await setState(sql, SRC, { last_run_at: started });
  try {
    let upserted = 0;
    let deleted = 0;
    let mode: "backfill" | "incremental" = "incremental";
    const batches = await loadLocalTimeBatches(sql);

    const backfill = await getState(sql, BACKFILL);
    if (backfill?.cursor !== "done") {
      mode = "backfill";
      // Anchor the incremental cursor at the START of the first backfill, so
      // anything edited while we page through history is caught afterwards.
      if (!(await getState(sql, SRC))?.cursor) await setState(sql, SRC, { cursor: started.toISOString() });

      let page = Number(backfill?.cursor ?? 1) || 1;
      for (;;) {
        const res = await hevy.getWorkoutsPage(page);
        for (const w of res.items) await upsertWorkout(sql, w, timezone, batches);
        upserted += res.items.length;
        const finished = page >= res.page_count;
        await setState(sql, BACKFILL, { cursor: finished ? "done" : String(page + 1) });
        if (finished) break;
        page++;
        if (!timeLeft()) {
          await setState(sql, SRC, { last_ok_at: now(), last_error: null });
          return { source: SRC, ok: true, mode, workoutsUpserted: upserted, workoutsDeleted: 0, complete: false };
        }
      }
    }

    // Incremental (also runs right after a backfill finishes, if time remains).
    if (mode === "incremental" || timeLeft()) {
      const since = (await getState(sql, SRC))?.cursor ?? "1970-01-01T00:00:00Z";
      const latest = new Map<string, HevyEvent>();
      for (let page = 1; ; page++) {
        const res = await hevy.getEventsPage(since, page);
        for (const ev of res.items) {
          const id = ev.type === "updated" ? ev.workout.id : ev.id;
          const prev = latest.get(id);
          if (!prev || eventTime(ev) >= eventTime(prev)) latest.set(id, ev);
        }
        if (page >= res.page_count) break;
        if (!timeLeft()) {
          // Not finished: leave the cursor where it was and try again next run.
          await setState(sql, SRC, { last_ok_at: now(), last_error: null });
          return { source: SRC, ok: true, mode, workoutsUpserted: upserted, workoutsDeleted: deleted, complete: false };
        }
      }
      for (const ev of latest.values()) {
        if (ev.type === "updated") {
          await upsertWorkout(sql, ev.workout, timezone, batches);
          upserted++;
        } else {
          await markWorkoutDeleted(sql, ev.id);
          deleted++;
        }
      }
      await setState(sql, SRC, { cursor: started.toISOString() });
    }

    await setState(sql, SRC, { last_ok_at: now(), last_error: null });
    return { source: SRC, ok: true, mode, workoutsUpserted: upserted, workoutsDeleted: deleted, complete: true };
  } catch (err) {
    const message = (err as Error).message;
    await setState(sql, SRC, { last_error: message });
    return { source: SRC, ok: false, error: message };
  }
}

// A delete wins a tie with an update at the same instant.
function eventTime(ev: HevyEvent): number {
  return Date.parse(ev.type === "updated" ? ev.workout.updated_at : ev.deleted_at) + (ev.type === "deleted" ? 1 : 0);
}

// ---- exercise templates -----------------------------------------------------

// Hevy can drop exercises (reverting an import deletes the custom ones it created). A template
// the full listing no longer returns is gone for good, so keep our copy in step: a stale row
// could be matched by name and sent to Hevy as an id it no longer has. Only a COMPLETE listing
// is trusted, and a suspiciously small one (empty, or under half of what we hold) prunes nothing.
export async function pruneMissingTemplates(sql: Sql, seen: string[]): Promise<number> {
  if (seen.length === 0) return 0;
  const [{ n }] = await sql<{ n: string }[]>`select count(*) as n from exercise_templates`;
  if (seen.length < Number(n) / 2) return 0;
  const gone = await sql`delete from exercise_templates where id not in ${sql(seen)} returning id`;
  return gone.length;
}

export async function syncHevyTemplates(deps: SyncDeps): Promise<SyncResult> {
  const { sql, hevy } = deps;
  const now = deps.now ?? (() => new Date());
  const SRC = "hevy_templates";
  if (!hevy) return { source: SRC, ok: true, skipped: "Hevy is not set up (no HEVY_API_KEY)" };
  await setState(sql, SRC, { last_run_at: now() });
  try {
    let count = 0;
    const seen: string[] = [];
    for (let page = 1; ; page++) {
      const res = await hevy.getTemplatesPage(page);
      const rows = res.items.map((t) => parseTemplate(t, now()));
      seen.push(...rows.map((r) => r.id));
      if (rows.length > 0) {
        await sql`
          insert into exercise_templates ${sql(
            rows.map((r) => ({ ...r, secondary_muscles: sql.json(r.secondary_muscles as never) })),
          )}
          on conflict (id) do update set
            title = excluded.title, type = excluded.type,
            primary_muscle = excluded.primary_muscle, secondary_muscles = excluded.secondary_muscles,
            equipment = excluded.equipment, is_custom = excluded.is_custom,
            updated_at = excluded.updated_at`;
      }
      count += rows.length;
      if (page >= res.page_count) break;
    }
    const pruned = await pruneMissingTemplates(sql, seen);
    await setState(sql, SRC, { last_ok_at: now(), last_error: null });
    return { source: SRC, ok: true, templatesUpserted: count, templatesPruned: pruned, complete: true };
  } catch (err) {
    const message = (err as Error).message;
    await setState(sql, SRC, { last_error: message });
    return { source: SRC, ok: false, error: message };
  }
}

// Each source runs independently: one failure never blocks the other (§9).
export async function syncHevy(deps: SyncDeps): Promise<SyncResult[]> {
  if (!deps.hevy) return [];
  const workouts = await syncHevyWorkouts(deps);
  const templates = await syncHevyTemplates(deps);
  return [workouts, templates];
}
