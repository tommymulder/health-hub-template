import { localTime } from "../time";
import { bestE1rmSet, hardSetCount, sessionVolumeKg, topSet } from "../metrics";
import { outWeight } from "../units";
import { ToolError, resolveWindow, type ToolCtx } from "./context";
export { resolveWindow };
import { fmtLoadedSets, fmtSet } from "./format";
import { durationMin, loadWorkouts, type LoadedExercise } from "./load";
import { ouraContextFor } from "./ouraContext";
import { classEntry, loadClassSessions } from "./classes";
import { compareExercise } from "../compare/exercise";
import { describeComparison } from "../compare/format";
import { loadSessionsForTemplates } from "../compare/load";

const MAX_WORKOUTS = 100;

const workingSets = (exs: LoadedExercise[]) => exs.reduce((n, e) => n + hardSetCount(e.sets), 0);
const volumeKg = (exs: LoadedExercise[]) => exs.reduce((n, e) => n + sessionVolumeKg(e.sets, e.direction), 0);

export async function getRecentWorkouts(ctx: ToolCtx, input: { days?: number; start?: string; end?: string }) {
  const { start, end } = resolveWindow(ctx, input, 14);
  // A class's Hevy copy is shown ONCE, as the class (with its board and completion), not again as a lifting session.
  const ids = await ctx.sql<{ id: string }[]>`
    select id from workouts where not deleted and local_date between ${start} and ${end}
      and id not in (select hevy_workout_id from class_sessions where hevy_workout_id is not null)
    order by start_at desc limit ${MAX_WORKOUTS + 1}`;
  const truncated = ids.length > MAX_WORKOUTS;
  const workouts = await loadWorkouts(ctx.sql, ids.slice(0, MAX_WORKOUTS).map((r) => r.id));
  const classSessions = await loadClassSessions(ctx, start, end);
  const classEntries = await Promise.all(classSessions.map((c) => classEntry(ctx, c)));

  return {
    units: ctx.units,
    window: { start, end },
    count: workouts.length + classEntries.length,
    ...(truncated ? { truncated: `Showing the newest ${MAX_WORKOUTS}; narrow the window for older ones.` } : {}),
    total_volume: outWeight(volumeKg(workouts.flatMap((w) => w.exercises)) + classSessions.reduce((n, c) => n + c.volume_kg, 0), ctx.units),
    // newest first across lifting sessions and classes
    workouts: [
      ...workouts.map((w) => ({
        sortKey: w.start_at.getTime(),
        entry: {
          kind: "lifting" as const,
          id: w.id,
          date: w.local_date,
          time: localTime(w.start_at, ctx.timezone),
          title: w.title,
          duration_min: durationMin(w),
          exercises: w.exercises.map((e) => e.title),
          working_sets: workingSets(w.exercises),
          volume: outWeight(volumeKg(w.exercises), ctx.units),
        },
      })),
      ...classSessions.map((c, i) => ({ sortKey: c.start.getTime(), entry: classEntries[i] })),
    ].sort((a, b) => b.sortKey - a.sortKey).map((x) => x.entry),
  };
}

export async function getWorkoutDetails(ctx: ToolCtx, input: { workout_id?: string }) {
  const wanted = input.workout_id ?? "latest";
  const [row] =
    wanted === "latest"
      ? await ctx.sql<{ id: string }[]>`select id from workouts where not deleted order by start_at desc limit 1`
      : await ctx.sql<{ id: string }[]>`select id from workouts where id = ${wanted} and not deleted`;
  if (!row) throw new ToolError(wanted === "latest" ? "There are no workouts stored yet." : `No workout with id ${wanted}. Use get_recent_workouts to find ids.`);

  const [w] = await loadWorkouts(ctx.sql, [row.id]);
  const oura = await ouraContextFor(ctx, w);
  const [cls] = await ctx.sql<{ id: string; class_type: string; completion_pct: string | null; precision: string }[]>`
    select id, class_type, completion_pct, precision from class_sessions where hevy_workout_id = ${w.id} limit 1`;
  // "vs last time" for every exercise (gym or class): this workout against the sessions BEFORE it, from the shared loader.
  const vsLast = new Map<string, ReturnType<typeof describeComparison>>();
  // Every exercise's history in two queries in all (not a pair per exercise).
  const histories = await loadSessionsForTemplates(ctx.sql, [...new Set(w.exercises.map((e) => e.template_id).filter((t): t is string => !!t))]);
  for (const e of w.exercises) {
    if (!e.template_id || vsLast.has(e.template_id)) continue;
    const all = histories.get(e.template_id) ?? [];
    const today = all.find((s) => s.wid === w.id);
    if (!today) continue;
    const history = all.filter((s) => s.start_at < w.start_at && s.wid !== w.id);
    vsLast.set(e.template_id, describeComparison(compareExercise(today, history, { type: e.template_type, title: e.title }), today, history, { type: e.template_type, title: e.title, units: ctx.units }));
  }
  return {
    units: ctx.units,
    workout: {
      id: w.id,
      title: w.title,
      description: w.description,
      date: w.local_date,
      time: localTime(w.start_at, ctx.timezone),
      duration_min: durationMin(w),
    },
    ...(cls ? { class: { class_session_id: Number(cls.id), class_type: cls.class_type, completion_pct: cls.completion_pct === null ? null : Number(cls.completion_pct), precision: cls.precision, note: "This workout is a logged class; get_class_history has the board and what was planned vs done." } } : {}),
    oura,
    totals: { exercises: w.exercises.length, working_sets: workingSets(w.exercises), volume: outWeight(volumeKg(w.exercises), ctx.units) },
    exercises: w.exercises.map((e) => {
      const top = topSet(e.sets, e.direction);
      const be = bestE1rmSet(e.sets, e.direction);
      return {
        position: e.position,
        title: e.title,
        template_id: e.template_id,
        ...(e.superset_id !== null ? { superset: e.superset_id } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
        working_sets: hardSetCount(e.sets),
        top_set: top ? fmtSet(top, ctx.units) : null,
        best_e1rm: outWeight(be?.value ?? null, ctx.units),
        ...(be ? { best_e1rm_from: fmtSet(be.set, ctx.units) } : {}),
        volume: outWeight(sessionVolumeKg(e.sets, e.direction), ctx.units),
        ...(e.template_id && vsLast.has(e.template_id) ? { vs_last_time: vsLast.get(e.template_id) } : {}),
        ...(e.direction === "least_assisted" ? { note: "assisted: weight is the help you get, lower is harder" } : {}),
        sets: fmtLoadedSets(e.sets, ctx.units),
      };
    }),
  };
}
