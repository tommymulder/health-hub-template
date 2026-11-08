import type { BlockInput, DoneSet, MovementInput, Target } from "./types";

// What was actually done, when the caller didn't spell it out set by set. Everything derived is
// CONSERVATIVE and flagged `assumed`: lower end of ranges, fewest sets, no weight guessed.
export interface Derived {
  sets: DoneSet[];
  assumed: boolean;
  notes: string[];
}

// How many times a block was done: explicit, else scaled from an overall %, else the conservative low end.
export function blockCount(block: BlockInput, completionPct?: number): { count: number; assumed: boolean } {
  if (block.sets_done !== undefined) return { count: Math.max(0, Math.round(block.sets_done)), assumed: false };
  const base = block.format === "sets" ? (block.sets?.max ?? block.sets?.min ?? 1) : (block.rounds ?? block.sets?.max ?? 1);
  if (completionPct !== undefined) return { count: Math.max(1, Math.round((base * completionPct) / 100)), assumed: true };
  const low = block.format === "sets" ? (block.sets?.min ?? 1) : (block.rounds ?? 1);
  return { count: low, assumed: block.format === "sets" && block.sets?.min !== block.sets?.max };
}

function repsFor(target: Target, i: number): { reps?: number; assumed: boolean } {
  if (target.reps_by_set?.length) return { reps: target.reps_by_set[Math.min(i, target.reps_by_set.length - 1)], assumed: false };
  if (typeof target.reps === "number") return { reps: target.reps, assumed: false };
  if (target.reps && typeof target.reps === "object") return { reps: target.reps.min, assumed: target.reps.min !== target.reps.max }; // low end of a range
  return { assumed: false };
}

const weightAt = (w: number | number[] | undefined, i: number): number | undefined =>
  w === undefined ? undefined : Array.isArray(w) ? w[Math.min(i, w.length - 1)] : w;

export function deriveDoneSets(block: BlockInput, m: MovementInput, completionPct?: number): Derived {
  if (m.done_sets) return { sets: m.done_sets, assumed: Boolean(m.assumed), notes: [] };

  const { count, assumed: countAssumed } = blockCount(block, completionPct);
  const notes: string[] = [];
  let assumed = countAssumed || Boolean(m.assumed);
  const sets: DoneSet[] = [];

  // "MAX reps in the remaining time" can't be derived: the count is only known to the person who did it.
  if (m.target.max && m.target.reps === undefined && !m.target.reps_by_set) {
    return { sets: [], assumed: true, notes: [`${m.movement}: max-rep count not given, so no sets were logged for it`] };
  }

  for (let i = 0; i < count; i++) {
    const r = repsFor(m.target, i);
    if (r.assumed) assumed = true;
    const set: DoneSet = { type: "normal" };
    if (r.reps !== undefined) set.reps = m.target.per_side ? r.reps * 2 : r.reps; // stored reps are BOTH sides combined ("8/ARM" = 16)
    if (m.target.duration_s !== undefined) set.duration_s = m.target.duration_s;
    if (m.target.distance_m !== undefined) set.distance_m = m.target.distance_m;
    const w = weightAt(m.weight, i);
    if (w !== undefined) set.weight = w;
    sets.push(set);
  }
  if (count > 0 && completionPct !== undefined && block.sets_done === undefined) notes.push(`${count} of ${block.sets?.max ?? block.rounds ?? count} sets/rounds (from ${completionPct}% overall)`);
  return { sets, assumed, notes };
}
