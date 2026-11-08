import type { Sql } from "../db";
import { directionFor, type Direction } from "../metrics";
import { num } from "./context";

export interface LoadedSet {
  position: number;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
}

export interface LoadedExercise {
  position: number;
  title: string;
  template_id: string | null;
  template_type: string | null;
  direction: Direction;
  primary_muscle: string | null;
  secondary_muscles: string[];
  superset_id: number | null;
  notes: string | null;
  sets: LoadedSet[];
}

export interface LoadedWorkout {
  id: string;
  title: string | null;
  description: string | null;
  start_at: Date;
  end_at: Date;
  local_date: string;
  exercises: LoadedExercise[];
}

interface Row {
  id: string; title: string | null; description: string | null; start_at: Date; end_at: Date; local_date: string;
  e_pos: number | null; exercise_title: string | null; exercise_template_id: string | null; superset_id: number | null; notes: string | null;
  t_type: string | null; primary_muscle: string | null; secondary_muscles: string[] | null;
  s_pos: number | null; set_type: string | null; weight_kg: string | null; reps: number | null;
  rpe: string | null; duration_s: number | null; distance_m: string | null;
}

// Newest first. Numeric columns arrive from Postgres as strings, so convert here, once.
export async function loadWorkouts(sql: Sql, ids: string[]): Promise<LoadedWorkout[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Row[]>`
    select w.id, w.title, w.description, w.start_at, w.end_at, w.local_date::text as local_date,
           e.position as e_pos, e.exercise_title, e.exercise_template_id, e.superset_id, e.notes,
           t.type as t_type, t.primary_muscle, t.secondary_muscles,
           s.position as s_pos, s.set_type, s.weight_kg, s.reps, s.rpe, s.duration_s, s.distance_m
    from workouts w
    left join workout_exercises e on e.workout_id = w.id
    left join exercise_templates t on t.id = e.exercise_template_id
    left join sets s on s.workout_exercise_id = e.id
    where w.id in ${sql(ids)}
    order by w.start_at desc, e.position, s.position`;

  const workouts = new Map<string, LoadedWorkout>();
  const exercises = new Map<string, LoadedExercise>();
  for (const r of rows) {
    let w = workouts.get(r.id);
    if (!w) {
      w = { id: r.id, title: r.title, description: r.description, start_at: r.start_at, end_at: r.end_at, local_date: r.local_date, exercises: [] };
      workouts.set(r.id, w);
    }
    if (r.e_pos === null) continue;
    const key = `${r.id}:${r.e_pos}`;
    let e = exercises.get(key);
    if (!e) {
      e = {
        position: r.e_pos, title: r.exercise_title!, template_id: r.exercise_template_id,
        template_type: r.t_type, direction: directionFor(r.t_type),
        primary_muscle: r.primary_muscle, secondary_muscles: r.secondary_muscles ?? [],
        superset_id: r.superset_id, notes: r.notes, sets: [],
      };
      exercises.set(key, e);
      w.exercises.push(e);
    }
    if (r.s_pos !== null) {
      e.sets.push({
        position: r.s_pos, set_type: r.set_type!, weight_kg: num(r.weight_kg), reps: r.reps,
        rpe: num(r.rpe), duration_s: r.duration_s, distance_m: num(r.distance_m),
      });
    }
  }
  return [...workouts.values()];
}

export const durationMin = (w: { start_at: Date; end_at: Date }): number =>
  Math.round((w.end_at.getTime() - w.start_at.getTime()) / 60_000);
