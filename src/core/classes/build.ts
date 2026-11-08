import type { WorkoutBody, WorkoutExerciseBody, WorkoutSetBody } from "../hevy/write";
import { lbToKg, type Units } from "../units";
import type { BlockInput, ClassInput, ClassType, DoneSet, MovementInput, Target } from "./types";

const TYPE_LABEL: Record<ClassType, string> = { strength: "Strength", strength_hiit: "Strength HIIT", cardio_endurance: "Cardio Endurance", mixed: "Mixed" };
const MAX_DESCRIPTION = 2000;

export interface ResolvedMovement {
  m: MovementInput;
  templateId: string;
  templateTitle: string;
  templateType: string | null; // Hevy's exercise type decides which set fields it shows (distance, time, reps, weight)
  sets: DoneSet[];
  assumed: boolean;
  notes: string[];
}
export interface ResolvedBlock { block: BlockInput; movements: ResolvedMovement[] }

export const classTitle = (i: Pick<ClassInput, "gym" | "class_type" | "title">) => i.title?.trim() || `${i.gym} — ${TYPE_LABEL[i.class_type]}`;
const toKg = (w: number, units: Units) => (units === "lb" ? lbToKg(w) : w); // full precision, never rounded

// Which set fields each Hevy exercise type shows. A field the type doesn't show is IGNORED by Hevy: on 2026-10-13
// a 200 m ski went out as "reps: 150" on a distance exercise and Hevy showed 0 mi. Distance is always sent in meters;
// the Hevy app converts it to miles or km for display.
export const TYPE_FIELDS: Record<string, { weight: boolean; reps: boolean; duration: boolean; distance: boolean }> = {
  weight_reps: { weight: true, reps: true, duration: false, distance: false },
  bodyweight_weighted: { weight: true, reps: true, duration: false, distance: false },
  bodyweight_assisted: { weight: true, reps: true, duration: false, distance: false },
  reps_only: { weight: false, reps: true, duration: false, distance: false },
  duration: { weight: false, reps: false, duration: true, distance: false },
  weight_duration: { weight: true, reps: false, duration: true, distance: false },
  distance_duration: { weight: false, reps: false, duration: true, distance: true },
  short_distance_weight: { weight: true, reps: false, duration: false, distance: true },
};

// What a set needs before it can be sent: null = fine, else the reason (shown in the dry run, nothing is sent).
export function missingFor(type: string | null, s: DoneSet): string | null {
  const f = type ? TYPE_FIELDS[type] : undefined;
  if (!f) return null; // unknown type: send what we have
  if (f.distance && !f.duration && s.distance_m === undefined) return "a distance (distance_m, in meters)";
  if (f.distance && f.duration && s.distance_m === undefined && s.duration_s === undefined) return "a distance (distance_m, in meters) or a time (duration_s)";
  if (!f.distance && f.duration && s.duration_s === undefined) return "a time (duration_s)";
  if (f.reps && !f.duration && s.reps === undefined) return "reps";
  return null;
}

export function hevySet(s: DoneSet, type: string | null, units: Units): WorkoutSetBody {
  const f = (type && TYPE_FIELDS[type]) || { weight: true, reps: true, duration: true, distance: true }; // unknown type: everything we have
  return {
    type: s.type ?? "normal",
    weight_kg: f.weight && s.weight !== undefined ? toKg(s.weight, units) : null,
    reps: f.reps ? (s.reps ?? null) : null,
    duration_seconds: f.duration ? (s.duration_s ?? null) : null,
    distance_meters: f.distance && s.distance_m !== undefined ? Math.round(s.distance_m) : null,
    custom_metric: null,
    rpe: null,
  };
}

// One set in plain words, in the user's units: "16 @ 10 lb", "200 m", "60 s".
const num = (n: number) => String(Math.round(n * 10) / 10);
function setText(s: DoneSet, units: Units): string {
  const parts: string[] = [];
  if (s.distance_m !== undefined) parts.push(`${num(s.distance_m)} m`);
  if (s.reps !== undefined && s.distance_m === undefined) parts.push(String(s.reps));
  if (s.duration_s !== undefined) parts.push(s.duration_s % 60 === 0 && s.duration_s >= 60 ? `${s.duration_s / 60} min` : `${s.duration_s} s`);
  const head = parts.join(" in ") || "done";
  return s.weight !== undefined && s.weight > 0 ? `${head} @ ${num(s.weight)} ${units}` : head;
}
// "2 x 16 @ 10 lb" when every set was the same, else each set: "18, 18, 10".
export function setsText(sets: DoneSet[], units: Units): string {
  const t = sets.map((s) => setText(s, units));
  if (t.length === 0) return "not counted";
  return t.every((x) => x === t[0]) ? (t.length === 1 ? t[0] : `${t.length} x ${t[0]}`) : t.join(", ");
}

function blockLabel(b: BlockInput): string {
  if (b.format === "sets") return `Block ${b.label}${b.sets ? ` (${b.sets.min === b.sets.max ? b.sets.min : `${b.sets.min}-${b.sets.max}`} sets)` : ""}`;
  if (b.format === "every_n_minutes") return `Block ${b.label} (every ${Math.round((b.interval_s ?? 0) / 60)} min x ${b.rounds ?? "?"} rounds)`;
  return `Block ${b.label} (${b.format.replace(/_/g, " ")}${b.rounds ? `, ${b.rounds} rounds` : ""})`;
}

// Notation Hevy has no field for goes in the exercise note: per-side, complexes, RX/scaled, assumptions.
function exerciseNote(r: ResolvedMovement, b: BlockInput): string {
  const t: Target = r.m.target;
  const parts = [blockLabel(b)];
  if (t.per_side) {
    const x = typeof t.reps === "number" ? t.reps : null;
    parts.push(x !== null ? `reps are both sides combined (${x * 2} = ${x} per side)` : "reps are both sides combined (2 x the per-side reps)");
  }
  if (t.complex) parts.push(`${t.complex} complex${t.complex_note ? ` (${t.complex_note})` : ""}: one rep = the whole sequence`);
  if (r.m.variant_done) {
    const alt = t.alternatives?.find((a) => a.label.toLowerCase() === r.m.variant_done!.toLowerCase());
    parts.push(`done as ${r.m.variant_done}${alt?.text ? `: ${alt.text}` : ""}`);
  }
  if (t.max) parts.push("max reps in the remaining time");
  const cal = r.sets.reduce((n, s) => n + (s.calories ?? 0), 0);
  if (cal > 0) parts.push(`machine showed ${Math.round(cal)} cal`); // Hevy has no calories field, so they live in the note
  if (r.assumed) parts.push("some values assumed, not stated");
  if (r.m.note) parts.push(r.m.note);
  return parts.join(". ");
}

export interface BuiltClass { body: WorkoutBody; skipped: string[]; assumptions: string[] }

// `description` is the coaching note (or the hub's fallback summary), never the station list: the workout itself shows the sets.
export function buildClassWorkout(a: { input: ClassInput; blocks: ResolvedBlock[]; start: Date; end: Date; units: Units; description: string }): BuiltClass {
  const exercises: WorkoutExerciseBody[] = [];
  const skipped: string[] = [];
  const assumptions: string[] = [];
  let nextSuperset = 0;

  for (const rb of a.blocks) {
    const included = rb.movements.filter((m) => m.sets.length > 0);
    for (const m of rb.movements) {
      if (m.sets.length === 0) skipped.push(`${rb.block.label}) ${m.m.movement}`);
      if (m.assumed) assumptions.push(`${rb.block.label}) ${m.m.movement}`);
      assumptions.push(...m.notes);
    }
    const superset = included.length >= 2 ? nextSuperset++ : null; // a block = a circuit = one Hevy superset (adjacent exercises)
    for (const r of included) {
      exercises.push({
        exercise_template_id: r.templateId,
        superset_id: superset,
        notes: exerciseNote(r, rb.block),
        sets: r.sets.map((s) => hevySet(s, r.templateType, a.units)),
      });
    }
  }

  return {
    body: {
      title: classTitle(a.input),
      description: a.description.slice(0, MAX_DESCRIPTION),
      start_time: a.start.toISOString(),
      end_time: a.end.toISOString(),
      is_private: false,
      exercises,
    },
    skipped,
    assumptions: [...new Set(assumptions)],
  };
}
