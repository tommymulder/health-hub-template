// The big five, by Hevy's built-in exercise titles. Edit this list to the lifts you track.
export const MAIN_LIFTS = [
  "Squat (Barbell)",
  "Bench Press (Barbell)",
  "Deadlift (Barbell)",
  "Overhead Press (Barbell)",
  "Bent Over Row (Barbell)",
] as const;

// Muscle groups used to rank "most / least trained". Excludes catch-alls
// (full_body, cardio, other) that would drown out real signal.
export const MAIN_MUSCLES = [
  "quadriceps", "hamstrings", "glutes", "calves",
  "chest", "lats", "upper_back", "lower_back", "shoulders", "traps",
  "biceps", "triceps", "forearms", "abdominals",
] as const;
