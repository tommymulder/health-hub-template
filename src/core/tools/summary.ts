import { MAIN_LIFTS, MAIN_MUSCLES } from "../lifts";
import { WORKING_SET_TYPES, muscleCredit } from "../metrics";
import { addDays, daysBetween, weekStart } from "../time";
import { outWeight } from "../units";
import { num, resolveWindow, todayLocal, type ToolCtx } from "./context";
import { classHeartRate, classMinutes, loadClassSessions } from "./classes";

const round1 = (n: number) => Math.round(n * 10) / 10;
const sortDesc = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round1(v)]));

export async function getTrainingSummary(ctx: ToolCtx, input: { start?: string; end?: string }) {
  const { start, end } = resolveWindow(ctx, input, 28);
  const types = [...WORKING_SET_TYPES];

  const sessionRows = await ctx.sql<{ week: string; n: string }[]>`
    select date_trunc('week', local_date)::date::text as week, count(*) as n
    from workouts where not deleted and local_date between ${start} and ${end}
      and id not in (select hevy_workout_id from class_sessions where hevy_workout_id is not null) -- a class counts once, as a class
    group by 1`;

  const setRows = await ctx.sql<{ week: string; tid: string | null; hard_sets: string; volume_kg: string | null }[]>`
    select date_trunc('week', w.local_date)::date::text as week, e.exercise_template_id as tid,
           count(*) as hard_sets,
           sum(case when t.type = 'bodyweight_assisted' then 0 else s.weight_kg * s.reps end) as volume_kg
    from workouts w
    join workout_exercises e on e.workout_id = w.id
    left join exercise_templates t on t.id = e.exercise_template_id
    join sets s on s.workout_exercise_id = e.id
    where not w.deleted and w.local_date between ${start} and ${end} and s.set_type in ${ctx.sql(types)}
    group by 1, 2`;

  const tids = [...new Set(setRows.map((r) => r.tid).filter((x): x is string => !!x))];
  const tpl = new Map<string, { primary: string | null; secondary: string[] }>();
  if (tids.length > 0) {
    const rows = await ctx.sql<{ id: string; primary_muscle: string | null; secondary_muscles: string[] | null }[]>`
      select id, primary_muscle, secondary_muscles from exercise_templates where id in ${ctx.sql(tids)}`;
    for (const r of rows) tpl.set(r.id, { primary: r.primary_muscle, secondary: r.secondary_muscles ?? [] });
  }

  // Every week in the window, including empty ones (a gap is information).
  const weeks = new Map<string, { sessions: number; hard_sets: number; volume_kg: number; muscles: Record<string, number> }>();
  for (let w = weekStart(start); w <= end; w = addDays(w, 7)) weeks.set(w, { sessions: 0, hard_sets: 0, volume_kg: 0, muscles: {} });
  for (const r of sessionRows) weeks.get(r.week)!.sessions = Number(r.n);
  for (const r of setRows) {
    const wk = weeks.get(r.week)!;
    const sets = Number(r.hard_sets);
    wk.hard_sets += sets;
    wk.volume_kg += num(r.volume_kg) ?? 0;
    const t = r.tid ? tpl.get(r.tid) : undefined;
    for (const [m, v] of Object.entries(muscleCredit(t?.primary ?? null, t?.secondary ?? null, sets))) wk.muscles[m] = (wk.muscles[m] ?? 0) + v;
  }

  // Classes: their SETS are already in the muscle totals (through the Hevy copy); here they count as sessions by kind.
  const classes = await loadClassSessions(ctx, start, end);
  const classKinds: Record<string, number> = {};
  const weekClasses = new Map<string, { count: number; minutes: number; by_type: Record<string, number> }>();
  let classMin = 0, hrWeighted = 0, hrMinutes = 0;
  for (const c of classes) {
    classKinds[c.class_type] = (classKinds[c.class_type] ?? 0) + 1;
    const wk = weekStart(c.date);
    const slot = weekClasses.get(wk) ?? { count: 0, minutes: 0, by_type: {} };
    const min = classMinutes(c);
    slot.count++; slot.minutes += min; slot.by_type[c.class_type] = (slot.by_type[c.class_type] ?? 0) + 1;
    weekClasses.set(wk, slot);
    classMin += min;
    const hr = await classHeartRate(ctx, c);
    if (hr?.avg) { hrWeighted += hr.avg * min; hrMinutes += min; }
  }

  // Classes Oura detected that were never logged (logging is optional, so this is most of them: on 2026-10-11 this
  // summary said 0 classes while get_trends counted 9). A detection overlapping a logged class IS that class.
  const unlogged = await ctx.sql<{ day: string; start_at: Date | null; end_at: Date | null }[]>`
    select d.day::text as day, d.start_at, d.end_at from oura_documents d
    where d.collection = 'workout' and d.data->>'activity' = 'fitnessClass' and d.day between ${start} and ${end}
      and not exists (select 1 from class_sessions s where s.start_at < d.end_at and s.end_at > d.start_at)
    order by d.start_at`;
  const unloggedMin = (u: { start_at: Date | null; end_at: Date | null }) =>
    u.start_at && u.end_at ? Math.max(0, Math.round((new Date(u.end_at).getTime() - new Date(u.start_at).getTime()) / 60000)) : 0;
  const unloggedByWeek = new Map<string, number>();
  for (const u of unlogged) unloggedByWeek.set(weekStart(u.day), (unloggedByWeek.get(weekStart(u.day)) ?? 0) + 1);

  const totalMuscles: Record<string, number> = {};
  let sessions = 0, hardSets = 0, volumeKg = 0;
  for (const wk of weeks.values()) {
    sessions += wk.sessions; hardSets += wk.hard_sets; volumeKg += wk.volume_kg;
    for (const [m, v] of Object.entries(wk.muscles)) totalMuscles[m] = (totalMuscles[m] ?? 0) + v;
  }

  const ranked = MAIN_MUSCLES.map((m) => ({ muscle: m, sets: round1(totalMuscles[m] ?? 0) })).sort((a, b) => b.sets - a.sets);

  const lastRows = await ctx.sql<{ title: string; last: string }[]>`
    select e.exercise_title as title, max(w.local_date)::text as last
    from workout_exercises e join workouts w on w.id = e.workout_id and not w.deleted
    where e.exercise_title in ${ctx.sql([...MAIN_LIFTS])} group by 1`;
  const today = todayLocal(ctx);
  const lastByTitle = new Map(lastRows.map((r) => [r.title, r.last]));

  return {
    units: ctx.units,
    window: { start, end },
    sessions_by_kind: { lifting: sessions, ...classKinds },
    classes: {
      count: classes.length, minutes: classMin, avg_heart_rate: hrMinutes > 0 ? Math.round((hrWeighted / hrMinutes) * 10) / 10 : null,
      oura_detected_not_logged: { count: unlogged.length, minutes: unlogged.reduce((n, u) => n + unloggedMin(u), 0), dates: unlogged.map((u) => u.day) },
      total_including_oura_detected: classes.length + unlogged.length,
    },
    totals: { sessions, hard_sets: hardSets, volume: outWeight(volumeKg, ctx.units), hard_sets_by_muscle: sortDesc(totalMuscles) },
    classes_note: "classes.count are classes logged with log_class_workout (their sets are in the muscle totals). oura_detected_not_logged are fitness classes Oura detected that were never logged: they count as sessions, but their sets and muscles are unknown.",
    method: "Hard set = a set not labelled warm-up. A set counts 1 toward its primary muscle and 0.5 toward each secondary muscle. Caveat: history imported from another app may have no warm-up labels, so some warm-ups are counted as hard sets.",
    most_trained: ranked.slice(0, 3).filter((r) => r.sets > 0),
    least_trained: [...ranked].reverse().slice(0, 4),
    weeks: [...weeks.entries()].map(([week_start, w]) => ({
      week_start,
      sessions: w.sessions,
      ...(weekClasses.get(week_start) ? { classes: weekClasses.get(week_start) } : {}),
      ...(unloggedByWeek.get(week_start) ? { oura_detected_classes_not_logged: unloggedByWeek.get(week_start) } : {}),
      hard_sets: w.hard_sets,
      volume: outWeight(w.volume_kg, ctx.units),
      hard_sets_by_muscle: sortDesc(w.muscles),
    })),
    main_lifts: MAIN_LIFTS.map((lift) => {
      const last = lastByTitle.get(lift);
      return { lift, last_done: last ?? null, days_ago: last ? daysBetween(last, today) : null };
    }),
  };
}
