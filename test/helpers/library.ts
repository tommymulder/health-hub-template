import type { Sql } from "@/core/db";

// A small stand-in for Hevy's built-in exercise library, inserted INSIDE a test's always-rolled-back transaction.
// A fresh hub gets the real library from its first Hevy sync; the tests must not depend on that having happened.
// Ids, titles, types and muscles are Hevy's own (public library data).
const LIBRARY: [id: string, title: string, type: string, muscle: string, equipment: string][] = [
  ["43573BB8", "Air Bike", "duration", "cardio", "machine"],
  ["79D0BB3A", "Bench Press (Barbell)", "weight_reps", "chest", "barbell"],
  ["3601968B", "Bench Press (Dumbbell)", "weight_reps", "chest", "dumbbell"],
  ["37FCC2BB", "Bicep Curl (Dumbbell)", "weight_reps", "biceps", "dumbbell"],
  ["BB792A36", "Burpee", "reps_only", "full_body", "none"],
  ["23A48484", "Cable Crunch", "weight_reps", "abdominals", "machine"],
  ["D8F7F851", "Cycling", "distance_duration", "cardio", "machine"],
  ["C6272009", "Deadlift (Barbell)", "weight_reps", "glutes", "barbell"],
  ["F1E57334", "Dumbbell Row", "weight_reps", "lats", "dumbbell"],
  ["970ADF87", "Hollow Rock", "duration", "abdominals", "none"],
  ["7B8D84E8", "Overhead Press (Barbell)", "weight_reps", "shoulders", "barbell"],
  ["018ADC12", "Pendlay Row (Barbell)", "weight_reps", "upper_back", "barbell"],
  ["C6C9B8A0", "Plank", "duration", "abdominals", "none"],
  ["1B2B1E7C", "Pull Up", "reps_only", "lats", "machine"],
  ["2C37EC5E", "Pull Up (Assisted)", "bodyweight_assisted", "lats", "machine"],
  ["392887AA", "Push Up", "reps_only", "chest", "none"],
  ["0222DB42", "Rowing Machine", "distance_duration", "cardio", "machine"],
  ["AC1BB830", "Running", "distance_duration", "cardio", "none"],
  ["022DF610", "Sit Up", "reps_only", "abdominals", "none"],
  ["5D99A2FA", "Ski Erg", "distance_duration", "cardio", "machine"],
  ["D04AC939", "Squat (Barbell)", "weight_reps", "quadriceps", "barbell"],
  ["3765684D", "Triceps Extension (Dumbbell)", "weight_reps", "triceps", "dumbbell"],
  ["6BE68B62", "V Up", "reps_only", "abdominals", "none"],
  ["A1F47ACC", "Wall Ball", "weight_reps", "full_body", "other"],
];

export async function seedLibrary(tx: Sql): Promise<void> {
  for (const [id, title, type, muscle, equipment] of LIBRARY) {
    await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at)
      values (${id}, ${title}, ${type}, ${muscle}, ${tx.json([])}, ${equipment}, false, now())
      on conflict (id) do nothing`;
  }
}
