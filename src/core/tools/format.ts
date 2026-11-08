import type { LoadedSet } from "./load";
import { outWeight, type Units } from "../units";

// Drop nulls so responses stay small and readable.
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export function fmtSet(s: { set_type: string; weight_kg: number | null; reps: number | null; rpe?: number | null; duration_s?: number | null; distance_m?: number | null }, units: Units) {
  return compact({
    type: s.set_type,
    weight: outWeight(s.weight_kg, units),
    reps: s.reps,
    rpe: s.rpe ?? null,
    duration_s: s.duration_s ?? null,
    distance_m: s.distance_m ?? null,
  });
}

export const fmtLoadedSets = (sets: LoadedSet[], units: Units) => sets.map((s) => fmtSet(s, units));
