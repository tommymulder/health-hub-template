import type { Sql } from "../db";
import { rankExercises } from "../match";
import { directionFor, topSet } from "../metrics";
import { num, type ToolCtx } from "./context";
import { fmtSet } from "./format";

export interface TemplateRow {
  id: string;
  title: string;
  type: string | null;
  primary_muscle: string | null;
  equipment: string | null;
  sessions: number; // how many workouts the user has done it in
  last_date: string | null;
}

export async function loadTemplates(sql: Sql): Promise<TemplateRow[]> {
  const rows = await sql<(Omit<TemplateRow, "sessions"> & { sessions: string | null })[]>`
    select t.id, t.title, t.type, t.primary_muscle, t.equipment, d.sessions, d.last_date
    from exercise_templates t
    left join (
      select e.exercise_template_id as id, count(distinct e.workout_id) as sessions, max(w.local_date)::text as last_date
      from workout_exercises e join workouts w on w.id = e.workout_id and not w.deleted
      group by 1
    ) d on d.id = t.id`;
  return rows.map((r) => ({ ...r, sessions: Number(r.sessions ?? 0) }));
}

export type Resolved =
  | { match: TemplateRow; others: string[] }
  | { match: null; suggestions: string[] };

// Find the one exercise the caller means. Prefers exercises the user has actually
// done; reports the runner-ups so Claude can ask if it guessed wrong.
export async function resolveExercise(sql: Sql, query: string): Promise<Resolved> {
  const all = await loadTemplates(sql);
  const byId = all.find((t) => t.id === query);
  if (byId) return { match: byId, others: [] };
  const ranked = rankExercises(query, all);
  const done = ranked.filter((r) => r.item.sessions > 0);
  if (done.length > 0) return { match: done[0].item, others: done.slice(1, 5).map((r) => r.item.title) };
  return { match: null, suggestions: ranked.slice(0, 5).map((r) => r.item.title) };
}

export async function searchExercises(ctx: ToolCtx, input: { query: string; limit?: number }) {
  const limit = input.limit ?? 10;
  const all = await loadTemplates(ctx.sql);
  const ranked = rankExercises(input.query, all).map((r) => r.item);
  // Exercises you've done come first (stable: keeps match quality within each group).
  const results = [...ranked.filter((t) => t.sessions > 0), ...ranked.filter((t) => t.sessions === 0)].slice(0, limit);

  const doneIds = results.filter((t) => t.sessions > 0).map((t) => t.id);
  const lastSets = new Map<string, { set_type: string; weight_kg: number | null; reps: number | null; duration_s: number | null }[]>();
  if (doneIds.length > 0) {
    const rows = await ctx.sql<{ tid: string; set_type: string; weight_kg: string | null; reps: number | null; duration_s: number | null }[]>`
      select e.exercise_template_id as tid, s.set_type, s.weight_kg, s.reps, s.duration_s
      from workout_exercises e
      join workouts w on w.id = e.workout_id and not w.deleted
      join sets s on s.workout_exercise_id = e.id
      where e.exercise_template_id in ${ctx.sql(doneIds)}
        and w.start_at = (
          select max(w2.start_at) from workouts w2 join workout_exercises e2 on e2.workout_id = w2.id
          where e2.exercise_template_id = e.exercise_template_id and not w2.deleted)`;
    for (const r of rows) {
      const list = lastSets.get(r.tid) ?? [];
      list.push({ set_type: r.set_type, weight_kg: num(r.weight_kg), reps: r.reps, duration_s: r.duration_s });
      lastSets.set(r.tid, list);
    }
  }

  return {
    units: ctx.units,
    query: input.query,
    count: results.length,
    note: "Use `id` as exercise_template_id when building a routine. Exercises you have done are listed first.",
    results: results.map((t) => {
      const top = topSet(lastSets.get(t.id) ?? [], directionFor(t.type));
      return {
        id: t.id,
        title: t.title,
        equipment: t.equipment,
        primary_muscle: t.primary_muscle,
        type: t.type,
        times_done: t.sessions,
        ...(t.last_date ? { last_done: t.last_date } : {}),
        ...(top ? { last_top_set: fmtSet(top, ctx.units) } : {}),
      };
    }),
  };
}

