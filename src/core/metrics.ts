// Pure training math. No database, no I/O: this is the logic that can be wrong,
// so it is isolated and unit-tested (CLAUDE.md).

export interface SetInput {
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  duration_s?: number | null;
}

// Hevy set types: warmup | normal | failure | dropset.
// "Working" = everything except warm-ups. Drop sets count toward volume and
// hard sets but not e1RM (the weight drops mid-set, so it isn't a true max effort).
export const WORKING_SET_TYPES = ["normal", "failure", "dropset"] as const; // single source of truth, also used in SQL
const WORKING = new Set<string>(WORKING_SET_TYPES);
const E1RM_TYPES = new Set(["normal", "failure"]);

export const isWorkingSet = (s: SetInput): boolean => WORKING.has(s.set_type);

// Epley overstates strength as reps climb (185 x 12 estimates 259 while the same
// day's 195 x 4 estimates 221), so sets above 10 reps produce no estimate.
export const E1RM_MAX_REPS = 10;

// Epley estimated one-rep max: w × (1 + reps/30). A single rep IS the max, so
// it returns the weight itself.
export function e1rm(weightKg: number | null, reps: number | null): number | null {
  if (weightKg === null || reps === null || weightKg <= 0 || reps < 1 || reps > E1RM_MAX_REPS) return null;
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
}

export function setE1rm(s: SetInput): number | null {
  return E1RM_TYPES.has(s.set_type) ? e1rm(s.weight_kg, s.reps) : null;
}

// The set that produced the best estimate, so callers can say "253 came from 200 x 8".
export function bestE1rmSet<T extends SetInput>(sets: T[], direction: Direction = "heaviest"): { set: T; value: number } | null {
  if (direction === "least_assisted") return null; // weight = assistance, so e1RM is meaningless
  let best: { set: T; value: number } | null = null;
  for (const s of sets) {
    const v = setE1rm(s);
    if (v !== null && (best === null || v > best.value)) best = { set: s, value: v };
  }
  return best;
}

export const bestE1rm = (sets: SetInput[], direction: Direction = "heaviest"): number | null =>
  bestE1rmSet(sets, direction)?.value ?? null;

// Volume = weight × reps over working sets. Bodyweight sets (no weight) add 0.
export function setVolumeKg(s: SetInput): number {
  if (!isWorkingSet(s) || s.weight_kg === null || s.reps === null) return 0;
  return s.weight_kg * s.reps;
}

// Assisted exercises (assisted pull-up) record the HELP you get, not weight you
// lifted, so they contribute no volume.
export const sessionVolumeKg = (sets: SetInput[], direction: Direction = "heaviest"): number =>
  direction === "least_assisted" ? 0 : sets.reduce((sum, s) => sum + setVolumeKg(s), 0);

export const hardSetCount = (sets: SetInput[]): number => sets.filter(isWorkingSet).length;

// For assisted exercises (assisted pull-up) the weight is the help you get:
// LESS is harder, so the "top" set is the one with the least assistance.
export type Direction = "heaviest" | "least_assisted";
export const directionFor = (templateType: string | null | undefined): Direction =>
  templateType === "bodyweight_assisted" ? "least_assisted" : "heaviest";

export function topSet<T extends SetInput>(sets: T[], direction: Direction = "heaviest"): T | null {
  const working = sets.filter(isWorkingSet);
  if (working.length === 0) return null;
  const reps = (s: T) => s.reps ?? 0;

  if (direction === "least_assisted") {
    return working.reduce((a, b) => {
      const wa = a.weight_kg ?? 0, wb = b.weight_kg ?? 0;
      return wb < wa || (wb === wa && reps(b) > reps(a)) ? b : a;
    });
  }
  const weighted = working.filter((s) => (s.weight_kg ?? 0) > 0);
  if (weighted.length > 0) {
    return weighted.reduce((a, b) => {
      const wa = a.weight_kg!, wb = b.weight_kg!;
      return wb > wa || (wb === wa && reps(b) > reps(a)) ? b : a;
    });
  }
  const withReps = working.filter((s) => (s.reps ?? 0) > 0);
  if (withReps.length > 0) return withReps.reduce((a, b) => (reps(b) > reps(a) ? b : a));
  return working.reduce((a, b) => ((b.duration_s ?? 0) > (a.duration_s ?? 0) ? b : a));
}

// true at index i when values[i] strictly beats every earlier non-null value.
// The very first value is a "first", not a PR, so it is false.
export function runningPRs(values: (number | null)[]): boolean[] {
  let max: number | null = null;
  return values.map((v) => {
    if (v === null) return false;
    const isPR = max !== null && v > max;
    if (max === null || v > max) max = v;
    return isPR;
  });
}

// Least-squares slope of value over day number. Needs 2+ distinct days.
export function slopePerDay(points: { day: number; value: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.day, 0) / n;
  const my = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0, den = 0;
  for (const p of points) {
    num += (p.day - mx) * (p.value - my);
    den += (p.day - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

// Hard sets credited to muscles: primary muscle 1 per set, each secondary 0.5.
export function muscleCredit(
  primary: string | null,
  secondary: string[] | null,
  hardSets: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (hardSets <= 0) return out;
  if (primary) out[primary] = (out[primary] ?? 0) + hardSets;
  for (const m of secondary ?? []) out[m] = (out[m] ?? 0) + hardSets * 0.5;
  return out;
}
