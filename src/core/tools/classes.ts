import { normalize } from "../match";
import { heartRateForWindow } from "../hr/window";
import { localTime } from "../time";
import { outWeight } from "../units";
import { ToolError, resolveWindow, type ToolCtx } from "./context";
import { loadCompletionClasses } from "../compare/classes";
import { classCompletion, completionTrends } from "../compare/completion";
import { compareExercise, type ExerciseSession } from "../compare/exercise";
import { describeComparison } from "../compare/format";

type Json = Record<string, unknown>;
interface Row {
  id: string; title: string; class_type: string; start_at: Date; end_at: Date; d: string; completion_pct: string | null; precision: string; hevy_workout_id: string | null; window_source: string;
  label: string | null; format: string | null; sets_done: string | null;
  position: number | null; movement: string | null; target: Json | null; variant_done: string | null; done_sets: Json[] | null; assumed: boolean | null; t_type: string | null; t_title: string | null; tpl: string | null;
}
interface DoneSetKg { reps?: number; weight_kg?: number; duration_s?: number; distance_m?: number; calories?: number }

export interface ClassMovementOut { movement: string; hevy_exercise: string | null; target: Json; variant: string | null; assumed: boolean; sets: DoneSetKg[]; assistedExercise: boolean; exerciseType: string | null }
export interface ClassBlockOut { label: string; format: string; sets_done: number | null; movements: ClassMovementOut[] }
export interface ClassSession {
  id: number; title: string; class_type: string; start: Date; end: Date; date: string; completion_pct: number | null; precision: string; hevy_workout_id: string | null; window_source: string;
  blocks: ClassBlockOut[]; working_sets: number; volume_kg: number;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// Class sessions in a local-date window, with their blocks and movements, newest first.
export async function loadClassSessions(ctx: ToolCtx, start: string, end: string, classType?: string): Promise<ClassSession[]> {
  const rows = await ctx.sql<Row[]>`
    select s.id, s.title, s.class_type, s.start_at, s.end_at, s.local_date::text as d, s.completion_pct, s.precision, s.hevy_workout_id, s.window_source,
           b.label, b.format, b.sets_done, m.position, m.movement, m.target, m.variant_done, m.done_sets, m.assumed, t.type as t_type, t.title as t_title, m.exercise_template_id as tpl
    from class_sessions s
    left join class_blocks b on b.session_id = s.id
    left join class_movements m on m.block_id = b.id
    left join exercise_templates t on t.id = m.exercise_template_id
    where s.local_date between ${start} and ${end} and (${classType ?? null}::text is null or s.class_type = ${classType ?? null})
    order by s.start_at desc, b.id, m.position`;

  const sessions = new Map<string, ClassSession>();
  const blocks = new Map<string, ClassBlockOut>();
  for (const r of rows) {
    let s = sessions.get(r.id);
    if (!s) {
      s = { id: Number(r.id), title: r.title, class_type: r.class_type, start: r.start_at, end: r.end_at, date: r.d, completion_pct: num(r.completion_pct), precision: r.precision,
        hevy_workout_id: r.hevy_workout_id, window_source: r.window_source, blocks: [], working_sets: 0, volume_kg: 0 };
      sessions.set(r.id, s);
    }
    if (r.label === null) continue;
    const bk = `${r.id}:${r.label}`;
    let b = blocks.get(bk);
    if (!b) { b = { label: r.label, format: r.format!, sets_done: num(r.sets_done), movements: [] }; blocks.set(bk, b); s.blocks.push(b); }
    if (r.movement === null) continue;
    const assisted = r.t_type === "bodyweight_assisted";
    const sets = (r.done_sets ?? []) as DoneSetKg[];
    b.movements.push({ movement: r.movement, hevy_exercise: r.t_title, target: r.target ?? {}, variant: r.variant_done, assumed: Boolean(r.assumed), sets, assistedExercise: assisted, exerciseType: r.t_type });
    s.working_sets += sets.length;
    if (!assisted) s.volume_kg += sets.reduce((n, d) => n + (d.weight_kg ?? 0) * (d.reps ?? 0), 0); // assisted = help received, not weight lifted
  }
  return [...sessions.values()];
}

export const classMinutes = (s: { start: Date; end: Date }) => Math.round((s.end.getTime() - s.start.getTime()) / 60_000);

export async function classHeartRate(ctx: ToolCtx, s: { start: Date; end: Date }) {
  const st = await heartRateForWindow(ctx, s.start, s.end);
  if (st.samples === 0) return null;
  return { samples: st.samples, avg: st.avg, max: st.max, covered_minutes: st.covered_minutes };
}

// The compact form used by get_recent_workouts.
export async function classEntry(ctx: ToolCtx, s: ClassSession) {
  return {
    kind: "class" as const,
    id: `class:${s.id}`,
    date: s.date,
    time: localTime(s.start, ctx.timezone),
    title: s.title,
    class_type: s.class_type,
    duration_min: classMinutes(s),
    completion_pct: s.completion_pct,
    precision: s.precision,
    exercises: s.blocks.flatMap((b) => b.movements.map((m) => m.hevy_exercise ?? m.movement)),
    working_sets: s.working_sets,
    volume: outWeight(s.volume_kg, ctx.units),
    heart_rate: await classHeartRate(ctx, s),
    ...(s.hevy_workout_id ? { hevy_workout_id: s.hevy_workout_id } : {}),
  };
}

const fmtSet = (d: DoneSetKg, ctx: ToolCtx) => ({
  ...(d.reps !== undefined ? { reps: d.reps } : {}),
  ...(d.weight_kg !== undefined ? { weight: outWeight(d.weight_kg, ctx.units) } : {}),
  ...(d.duration_s !== undefined ? { duration_s: d.duration_s } : {}),
  ...(d.distance_m !== undefined ? { distance_m: d.distance_m } : {}),
});

function movementMatches(movement: string, query: string): boolean {
  const q = normalize(query).split(" ").filter(Boolean);
  const m = normalize(movement);
  return q.length > 0 && q.every((t) => m.includes(t));
}

export async function getClassHistory(ctx: ToolCtx, input: { movement?: string; class_type?: string; days?: number }) {
  const { start, end } = resolveWindow(ctx, { days: input.days }, 90);
  let sessions = await loadClassSessions(ctx, start, end, input.class_type);
  if (input.movement) sessions = sessions.filter((s) => s.blocks.some((b) => b.movements.some((m) => movementMatches(m.movement, input.movement!))));
  if (sessions.length === 0) {
    throw new ToolError(input.movement
      ? `No logged class in the last ${input.days ?? 90} days includes "${input.movement}".`
      : "No classes are logged in that window. Log one with log_class_workout after a class.");
  }
  const shown = sessions.slice(0, 30);
  // Board completion is computed from the stored class facts every time (never stored), over ALL classes for the trend.
  const stored = await loadCompletionClasses(ctx.sql);
  const completionOf = new Map(stored.map((c) => [c.session_id, { c, comp: classCompletion(c) }]));
  const trend = completionTrends(stored.map((c) => ({ id: c.id, title: c.title, class_type: c.class_type, date: c.date, pct: completionOf.get(c.session_id)!.comp.pct })));
  const out = [];
  for (const s of shown) {
    const done = completionOf.get(s.id);
    out.push({
      id: `class:${s.id}`, session_id: s.id, date: s.date, time: localTime(s.start, ctx.timezone), title: s.title, class_type: s.class_type, duration_min: classMinutes(s),
      completion_pct: s.completion_pct, precision: s.precision, time_source: s.window_source, heart_rate: await classHeartRate(ctx, s),
      ...(done ? { completion: { pct: done.comp.pct, counted: done.comp.counted, blocks_finished: done.comp.blocks_finished, estimated: done.comp.estimated, ...(done.comp.excluded ? { excluded: done.comp.excluded } : {}), ...(done.comp.not_counted.length ? { not_counted: done.comp.not_counted } : {}), scaling: done.comp.scaling } } : {}),
      ...(done?.c.coaching_note ? { coaching_note: done.c.coaching_note } : {}),
      blocks: s.blocks.map((b) => ({
        block: b.label, format: b.format, sets_done: b.sets_done,
        movements: b.movements.filter((m) => !input.movement || movementMatches(m.movement, input.movement)).map((m) => ({
          movement: m.movement, hevy_exercise: m.hevy_exercise, board_target: m.target, ...(m.variant ? { variant_done: m.variant } : {}), ...(m.assumed ? { assumed: true } : {}),
          done: m.sets.map((d) => fmtSet(d, ctx)),
        })).filter(() => true),
      })).filter((b) => b.movements.length > 0),
    });
  }
  // Each session of a movement gains its comparison with the one before it (same Hevy exercise, oldest first).
  const asSession = (s: ClassSession, m: ClassMovementOut): ExerciseSession => ({
    wid: `class:${s.id}`, date: s.date, where: "class", assumed: m.assumed, complex: typeof m.target.complex === "string" ? m.target.complex : null,
    calories: m.sets.reduce((n, d) => n + (d.calories ?? 0), 0) || null,
    sets: m.sets.map((d) => ({ set_type: "normal", weight_kg: d.weight_kg ?? null, reps: d.reps ?? null, duration_s: d.duration_s ?? null, distance_m: d.distance_m ?? null })),
  });
  const movementHistory = input.movement
    ? (() => {
        const rows = shown.flatMap((s) => s.blocks.flatMap((b) => b.movements.filter((m) => movementMatches(m.movement, input.movement!)).map((m) => ({ s, m })))).reverse(); // oldest first
        const seen = new Map<string, ExerciseSession[]>();
        return rows.map(({ s, m }) => {
          const key = m.hevy_exercise ?? m.movement;
          const today = asSession(s, m);
          const before = seen.get(key) ?? [];
          seen.set(key, [...before, today]);
          const vs = before.length ? describeComparison(compareExercise(today, before, { type: m.exerciseType, title: key }), today, before, { type: m.exerciseType, title: key, units: ctx.units }) : null;
          return {
            date: s.date, movement: m.movement, ...(m.variant ? { variant: m.variant } : {}), sets: m.sets.map((d) => fmtSet(d, ctx)),
            total_reps: m.sets.reduce((n, d) => n + (d.reps ?? 0), 0), total_seconds: m.sets.reduce((n, d) => n + (d.duration_s ?? 0), 0),
            ...(vs ? { vs_previous: vs } : {}),
          };
        });
      })()
    : undefined;
  return {
    units: ctx.units, window: { start, end }, count: sessions.length,
    ...(sessions.length > 30 ? { truncated: "Showing the newest 30 classes." } : {}),
    note: "Barbell/dumbbell class lifts also appear in get_exercise_progress, because they map to the same Hevy exercises as the gym lifts. For assisted exercises the weight is the assistance.",
    completion_trend: trend,
    completion_note: "completion = the share of the posted work they did, computed from the stored board (weight never counts; a movement that can't be counted is left out and listed in not_counted, never scored 0). A verdict needs at least 8 countable classes and a 5-point change; otherwise only the numbers are shown. A different format or rep range is 'not compared', never 'worse'.",
    ...(movementHistory ? { movement_history: movementHistory } : {}),
    classes: out,
  };
}
