// Shapes taken from docs/hevy-openapi.json (the source of truth).
export interface HevySet {
  index: number;
  type: string; // warmup | normal | failure | dropset
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
  custom_metric: number | null;
}

export interface HevyExercise {
  index: number;
  title: string;
  notes?: string | null;
  exercise_template_id: string;
  superset_id: number | null;
  sets: HevySet[];
}

export interface HevyWorkout {
  id: string;
  title: string;
  routine_id?: string | null;
  description?: string | null;
  start_time: string;
  end_time: string;
  updated_at: string;
  created_at: string;
  exercises: HevyExercise[];
}

export interface HevyTemplate {
  id: string;
  title: string;
  type: string;
  primary_muscle_group: string;
  secondary_muscle_groups: string[];
  equipment: string;
  is_custom: boolean;
}

export type HevyEvent =
  | { type: "updated"; workout: HevyWorkout }
  | { type: "deleted"; id: string; deleted_at: string };

export interface Page<T> {
  page: number;
  page_count: number;
  items: T[];
}

// Read-only surface on purpose: Phase 2 has no way to write to Hevy
// (Hevy has no delete, so writes arrive deliberately in Phase 4).
export interface HevyApi {
  getWorkoutsPage(page: number): Promise<Page<HevyWorkout>>;
  getEventsPage(since: string, page: number): Promise<Page<HevyEvent>>;
  getTemplatesPage(page: number): Promise<Page<HevyTemplate>>;
  getWorkoutCount(): Promise<number>;
}
