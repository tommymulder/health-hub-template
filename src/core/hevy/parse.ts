import { localDate, wallClockToInstant } from "../time";
import type { HevyTemplate, HevyWorkout } from "./types";

export interface WorkoutRow {
  id: string;
  title: string | null;
  description: string | null;
  start_at: string;
  end_at: string;
  local_date: string;
  hevy_updated_at: string | null;
}

export interface ExerciseRow {
  position: number;
  exercise_template_id: string | null;
  exercise_title: string;
  superset_id: number | null;
  notes: string | null;
  sets: SetRow[];
}

export interface SetRow {
  position: number;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
}

// Pure mapping from Hevy's JSON to our rows. Weights stay in kg (DESIGN D6).
// Workouts imported into Hevy from a CSV with no timezone (for example another app's export) carry LOCAL clock
// times labelled as UTC. Batches are recognised by their shared Hevy `created_at` and
// listed in settings['hevy_local_time_batches']; their times are reinterpreted.
export function parseWorkout(
  w: HevyWorkout,
  timeZone: string,
  localTimeBatches: ReadonlySet<string> = new Set(),
): { workout: WorkoutRow; exercises: ExerciseRow[] } {
  const fix = localTimeBatches.has(w.created_at);
  const start = fix ? wallClockToInstant(w.start_time, timeZone).toISOString() : w.start_time;
  const end = fix ? wallClockToInstant(w.end_time, timeZone).toISOString() : w.end_time;
  return {
    workout: {
      id: w.id,
      title: w.title ?? null,
      description: w.description ?? null,
      start_at: start,
      end_at: end,
      local_date: localDate(start, timeZone),
      hevy_updated_at: w.updated_at ?? null,
    },
    exercises: (w.exercises ?? []).map((e) => ({
      position: e.index,
      exercise_template_id: e.exercise_template_id ?? null,
      exercise_title: e.title,
      superset_id: e.superset_id ?? null,
      notes: e.notes ?? null,
      sets: (e.sets ?? []).map((s) => ({
        position: s.index,
        set_type: s.type,
        weight_kg: s.weight_kg ?? null,
        reps: s.reps ?? null,
        rpe: s.rpe ?? null,
        duration_s: s.duration_seconds ?? null,
        distance_m: s.distance_meters ?? null,
      })),
    })),
  };
}

export function parseTemplate(t: HevyTemplate, now: Date) {
  return {
    id: t.id,
    title: t.title,
    type: t.type ?? null,
    primary_muscle: t.primary_muscle_group ?? null,
    secondary_muscles: t.secondary_muscle_groups ?? [],
    equipment: t.equipment ?? null,
    is_custom: Boolean(t.is_custom),
    updated_at: now.toISOString(),
  };
}
