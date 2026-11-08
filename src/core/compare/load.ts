import type { Sql } from "../db";
import type { CompareSet, ExerciseSession } from "./exercise";

// One loader for "every session of an exercise" (gym AND class), shared by get_exercise_progress, get_workout_details
// and the class coaching note. Rows are oldest first. Deleted workouts never count.
export interface LoadedSet extends CompareSet { rpe: number | null }
export interface LoadedSession extends ExerciseSession { start_at: Date; sets: LoadedSet[] }

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface Row { tpl: string; wid: string; start_at: Date; d: string; set_type: string; weight_kg: string | null; reps: number | null; rpe: string | null; duration_s: number | null; distance_m: string | null }
interface ClassRow { wid: string; tpl: string | null; assumed: boolean | null; complex: string | null; calories: string | null }

// Many exercises in TWO queries (a class has a dozen; one pair of queries each was seconds per call).
export async function loadSessionsForTemplates(sql: Sql, templateIds: string[], opts: { before?: Date } = {}): Promise<Map<string, LoadedSession[]>> {
  const out = new Map<string, LoadedSession[]>(templateIds.map((id) => [id, []]));
  if (templateIds.length === 0) return out;
  const before = opts.before ?? null;
  const rows = await sql<Row[]>`
    select e.exercise_template_id as tpl, w.id as wid, w.start_at, w.local_date::text as d, s.set_type, s.weight_kg, s.reps, s.rpe, s.duration_s, s.distance_m
    from workouts w
    join workout_exercises e on e.workout_id = w.id
    join sets s on s.workout_exercise_id = e.id
    where not w.deleted and e.exercise_template_id in ${sql(templateIds)} and (${before}::timestamptz is null or w.start_at < ${before})
    order by w.start_at, e.position, s.position`;

  const last = new Map<string, LoadedSession>(); // the session being filled, per exercise
  for (const r of rows) {
    const list = out.get(r.tpl)!;
    let cur = last.get(r.tpl);
    if (!cur || cur.wid !== r.wid) {
      cur = { wid: r.wid, date: r.d, start_at: new Date(r.start_at), where: "gym", assumed: false, complex: null, calories: null, sets: [] };
      list.push(cur);
      last.set(r.tpl, cur);
    }
    cur.sets.push({ set_type: r.set_type, weight_kg: n(r.weight_kg), reps: r.reps, rpe: n(r.rpe), duration_s: r.duration_s, distance_m: n(r.distance_m) });
  }

  // Sessions that were a logged class (their sets still count toward the exercise exactly once), and what the class
  // knows that Hevy doesn't: whether the numbers were assumed, a complex, and the machine calories.
  const wids = [...new Set(rows.map((r) => r.wid))];
  if (wids.length > 0) {
    const cls = await sql<ClassRow[]>`
      select cs.hevy_workout_id as wid, m.exercise_template_id as tpl, bool_or(m.assumed) as assumed, max(m.target->>'complex') as complex,
             sum((select sum((d->>'calories')::numeric) from jsonb_array_elements(coalesce(m.done_sets, '[]'::jsonb)) d)) as calories
      from class_sessions cs
      left join class_blocks b on b.session_id = cs.id
      left join class_movements m on m.block_id = b.id and m.exercise_template_id in ${sql(templateIds)}
      where cs.hevy_workout_id in ${sql(wids)}
      group by cs.hevy_workout_id, m.exercise_template_id`;
    const classWids = new Set(cls.map((c) => c.wid)); // every row is a logged class, even one with no movement for this exercise
    const byKey = new Map(cls.filter((c) => c.tpl !== null).map((c) => [`${c.wid}|${c.tpl}`, c]));
    for (const [tpl, sessions] of out) {
      for (const s of sessions) {
        if (!classWids.has(s.wid)) continue;
        s.where = "class";
        const c = byKey.get(`${s.wid}|${tpl}`);
        if (c) { s.assumed = Boolean(c.assumed); s.complex = c.complex ?? null; s.calories = n(c.calories); }
      }
    }
  }
  return out;
}

export async function loadExerciseSessions(sql: Sql, templateId: string, opts: { before?: Date } = {}): Promise<LoadedSession[]> {
  return (await loadSessionsForTemplates(sql, [templateId], opts)).get(templateId) ?? [];
}
