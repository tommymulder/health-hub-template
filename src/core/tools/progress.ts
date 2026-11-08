import { daysBetween, addDays } from "../time";
import { loadExerciseSessions } from "../compare/load";
import {
  bestE1rmSet, directionFor, hardSetCount, runningPRs, sessionVolumeKg, slopePerDay, topSet, type Direction, type SetInput,
} from "../metrics";
import { outWeight } from "../units";
import { ToolError, todayLocal, type ToolCtx } from "./context";
import { resolveExercise } from "./exercises";
import { fmtSet } from "./format";

const MAX_SESSIONS = 200;

interface Session { wid: string; date: string; where: "class" | "gym"; sets: (SetInput & { rpe: number | null })[] }

type Metric = "e1rm" | "less_assistance" | "reps" | "duration";

export async function getExerciseProgress(ctx: ToolCtx, input: { exercise: string; since?: string }) {
  const resolved = await resolveExercise(ctx.sql, input.exercise);
  if (!resolved.match) {
    throw new ToolError(
      `You haven't done "${input.exercise}" in Hevy.` +
        (resolved.suggestions.length ? ` Similar exercises: ${resolved.suggestions.join("; ")}.` : " Try search_exercises."),
    );
  }
  const t = resolved.match;
  const direction: Direction = directionFor(t.type);
  const today = todayLocal(ctx);
  const since = input.since ?? addDays(today, -180);

  // All history (not just the window) so PRs are real all-time PRs. The shared loader (compare/load.ts) also knows
  // which sessions were a logged class (their sets still count toward this exercise exactly once).
  const sessions: Session[] = (await loadExerciseSessions(ctx.sql, t.id)).map((x) => ({
    wid: x.wid, date: x.date, where: x.where,
    sets: x.sets.map((y) => ({ set_type: y.set_type, weight_kg: y.weight_kg, reps: y.reps, rpe: y.rpe, duration_s: y.duration_s ?? null })), // distance is not part of this tool's output
  }));

  const per = sessions.map((s) => {
    const top = topSet(s.sets, direction);
    const be = bestE1rmSet(s.sets, direction);
    return { s, top, e1rm: be?.value ?? null, e1rmSet: be?.set ?? null, volume: sessionVolumeKg(s.sets, direction), working: hardSetCount(s.sets) };
  });

  // Pick ONE metric for the whole exercise so PRs and trends compare like with like.
  const metric: Metric = per.some((p) => p.e1rm !== null)
    ? "e1rm"
    : direction === "least_assisted"
      ? "less_assistance"
      : per.some((p) => (p.top?.reps ?? 0) > 0)
        ? "reps"
        : "duration";
  const value = (p: (typeof per)[number]): number | null => {
    switch (metric) {
      case "e1rm": return p.e1rm;
      case "less_assistance": return p.top ? -(p.top.weight_kg ?? 0) : null;
      case "reps": return p.top?.reps ?? null;
      case "duration": return p.top?.duration_s ?? null;
    }
  };
  const values = per.map(value);
  const prs = runningPRs(values);

  const inWindow = per.map((p, i) => ({ p, pr: prs[i], v: values[i] })).filter((x) => x.p.s.date >= since);
  const shown = inWindow.slice(-MAX_SESSIONS);

  // Trend: least-squares slope of the session metric over time (per 30 days).
  let trend: Record<string, unknown> | null = null;
  const pts = inWindow.filter((x) => x.v !== null);
  if (metric === "e1rm" && pts.length >= 2) {
    const first = pts[0].p.s.date;
    const slope = slopePerDay(pts.map((x) => ({ day: daysBetween(first, x.p.s.date), value: x.v! })));
    const last = pts[pts.length - 1];
    const peak = pts.reduce((a, b) => (b.v! > a.v! ? b : a));
    trend = {
      metric: "best e1RM per session",
      first_session: { date: first, e1rm: outWeight(pts[0].v, ctx.units) },
      peak_session: { date: peak.p.s.date, e1rm: outWeight(peak.v, ctx.units) },
      last_session: { date: last.p.s.date, e1rm: outWeight(last.v, ctx.units) },
      last_vs_peak_pct: Math.round(((last.v! - peak.v!) / peak.v!) * 1000) / 10,
      change_per_30_days: slope === null ? null : outWeight(slope * 30, ctx.units),
      note: "change_per_30_days is a straight-line fit through the whole window; it misleads when progress rose then fell, so judge by first / peak / last.",
    };
  }

  // "Heaviest" is about the actual weight lifted, not the e1RM estimate.
  const heavy = (p: (typeof per)[number]): number | null =>
    metric === "e1rm" ? (p.top?.weight_kg ?? null) : value(p);
  const best = (key: "weight" | "e1rm") => {
    let pick: (typeof per)[number] | null = null;
    for (const p of per) {
      const v = key === "e1rm" ? p.e1rm : heavy(p);
      const cur = pick === null ? null : key === "e1rm" ? pick.e1rm : heavy(pick);
      if (v !== null && (cur === null || v > cur)) pick = p;
    }
    return pick;
  };
  const heaviest = best("weight");
  const bestE = best("e1rm");

  return {
    units: ctx.units,
    exercise: { id: t.id, title: t.title, type: t.type, primary_muscle: t.primary_muscle, equipment: t.equipment },
    ...(resolved.others.length ? { other_possible_matches: resolved.others, note: "Matched the closest exercise you have done; ask if the user meant another." } : {}),
    metric_note: metric === "e1rm"
      ? "e1RM = Epley estimate w × (1 + reps/30) from normal/failure sets of up to 10 reps; PR means a new all-time best e1RM."
      : metric === "less_assistance" ? "Assisted exercise: lower assistance weight is better." : "No weighted sets; progress is judged on reps or duration.",
    window: { since, until: today },
    sessions_in_window: inWindow.length,
    sessions_all_time: per.length,
    ...(inWindow.length > MAX_SESSIONS ? { truncated: `Showing the newest ${MAX_SESSIONS} sessions.` } : {}),
    trend,
    all_time: {
      first_session: per[0]?.s.date ?? null,
      last_session: per[per.length - 1]?.s.date ?? null,
      ...(heaviest?.top ? { top_set: { date: heaviest.s.date, ...fmtSet(heaviest.top, ctx.units) } } : {}),
      ...(bestE && bestE.e1rm !== null ? { best_e1rm: { date: bestE.s.date, value: outWeight(bestE.e1rm, ctx.units), from: bestE.e1rmSet ? fmtSet(bestE.e1rmSet, ctx.units) : null } } : {}),
    },
    sessions: shown.map(({ p, pr }) => ({
      date: p.s.date,
      workout_id: p.s.wid,
      where: p.s.where,
      working_sets: p.working,
      top_set: p.top ? fmtSet(p.top, ctx.units) : null,
      best_e1rm: outWeight(p.e1rm, ctx.units),
      ...(p.e1rmSet ? { best_e1rm_from: fmtSet(p.e1rmSet, ctx.units) } : {}), // NOT always the top set
      volume: outWeight(p.volume, ctx.units),
      ...(pr ? { pr: true } : {}),
    })),
  };
}
