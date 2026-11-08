// What Claude sends after reading the board photos and hearing the voice note (DESIGN section 8.1).
// Weights are in the user's units (lb); everything stored or sent to Hevy is converted to kg.

export type ClassType = "strength" | "strength_hiit" | "cardio_endurance" | "mixed";
export type Precision = "exact" | "partial" | "estimated";
export type BlockFormat = "sets" | "every_n_minutes" | "emom" | "amrap" | "for_time" | "intervals" | "other";

export interface Target {
  reps?: number | { min: number; max: number };
  reps_by_set?: number[]; // "8-6-4-2": set 1 = 8, set 2 = 6 ...
  per_side?: boolean; // "8/ARM"
  complex?: string; // "1+1+2"
  complex_note?: string;
  duration_s?: number; // timed hold
  distance_m?: number; // cardio machines: '200M SKI' = 200 (meters, whatever Hevy displays)
  max?: boolean; // "MAX reps in the remaining time"
  total?: boolean; // the number is for the WHOLE block, not each round ("cash out: 40 power cleans")
  share?: number; // the user's part when the work is split with a partner: above 0, at most 1 ("split with partner" = 0.5)
  optional?: boolean; // a "pick 2 of 3" choice: when nothing is done it is left out of completion, not counted as 0%
  calories?: number; // what the machine screen showed (kept in the hub; Hevy has no calories field)
  note?: string;
  alternatives?: { label: string; movement?: string; text?: string; target?: Target }[];
}

export interface DoneSet {
  reps?: number;
  weight?: number; // user units; for assisted exercises this is the assistance
  duration_s?: number;
  distance_m?: number; // meters
  calories?: number; // machine calories (hub only; goes in the Hevy exercise note)
  type?: "warmup" | "normal" | "failure" | "dropset";
}

export interface CustomExerciseRequest {
  exercise_type: string;
  muscle_group: string;
  equipment?: string;
  other_muscles?: string[];
  title?: string; // defaults to the movement name, title-cased
}

export interface MovementInput {
  movement: string; // normalised name: 'barbell bench press'
  exercise_template_id?: string; // explicit choice (from search_exercises); beats every other rule
  create_custom?: CustomExerciseRequest; // explicit request for a NEW (permanent) custom exercise
  target: Target;
  variant_done?: string | null; // null = as written | 'RX' | 'scaled' | free text
  done_sets?: DoneSet[]; // exactly what was done
  weight?: number | number[]; // convenience when done_sets is omitted: one weight, or one per set
  assumed?: boolean;
  note?: string;
}

export interface BlockInput {
  label: string;
  format: BlockFormat;
  sets?: { min: number; max: number };
  interval_s?: number;
  rounds?: number;
  time_cap_s?: number;
  sets_done?: number; // how many times the block was actually done
  finish_s?: number; // the time they finished a "for time" block in, when they finished it
  movements: MovementInput[];
}

export interface ClassInput {
  gym: string;
  class_type: ClassType;
  title?: string;
  start_at?: string; // explicit start (ISO with offset): wins over everything
  duration_min?: number;
  photo_time?: string; // when the board photo was taken: a HINT used to find the class in Oura
  date?: string; // local YYYY-MM-DD when there is no time at all
  board_text: string;
  blocks: BlockInput[];
  completion_pct?: number;
  precision: Precision;
  user_notes?: string;
  log_to_hevy?: boolean; // default true
  replaces_session_id?: number; // redo a class whose Hevy copy the user deleted in the app (DESIGN 8.1)
  coaching_note?: string; // the note Claude writes from the dry run's `analysis` (at most 1,500 characters); it becomes the Hevy description
}
