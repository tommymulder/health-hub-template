import { daysBetween, addDays } from "../time";
import { bestE1rmSet, topSet, isWorkingSet } from "../metrics";

// "vs last time" for any exercise (Phase 19 B). Pure: no database, no Next imports (DESIGN D9).
// A comparison is only fair when the conditions match (rep range, complex, units), so a mismatch is reported as
// `not_compared` with the reason, never as "worse". Values are kg, seconds, meters; the tool layer converts units.

export interface CompareSet {
  set_type: string; weight_kg: number | null; reps: number | null; duration_s?: number | null; distance_m?: number | null;
}
export interface ExerciseSession {
  wid: string; date: string; where: "class" | "gym"; assumed: boolean;
  complex: string | null; // a class complex ("1+1+2"): compared only with the same complex
  calories: number | null; // machine calories (class sessions only: Hevy has no calories field)
  sets: CompareSet[];
}

// Percent change below which the answer is "same" with no verdict (one place, so a rule change is one edit).
export const THRESHOLDS = { e1rm: 2.5, weight: 2.5, reps: 10, hold: 10, distance: 10, calories: 10, pace: 2, time: 5 } as const;
const REP_WINDOW = 3; // the best set's reps must be within 3 to compare directly
const SIMILAR_DAYS = 180; // how far back vs_similar looks
const TREND_DAYS = 90, TREND_MIN_SESSIONS = 3;
const SAME_WITHIN_PCT = 5; // "the same calories" / "the same time" for cardio
const DISTANCE_RATIO = [0.75, 1.34] as const; // a pace over very different distances isn't comparable

export type MeasureId = "e1rm" | "weight" | "assistance" | "reps" | "hold" | "pace" | "time" | "calories";
type Unit = "kg" | "reps" | "s" | "sec_per_500m" | "min_per_mile" | "cal";
export type Verdict = "better" | "worse" | "same";
export interface Value { value: number | null; unit: Unit }
export interface Change { abs: number; pct: number | null }
export interface Compared { change: Change; verdict: Verdict; via?: string }

export interface Comparison {
  first_time: boolean;
  measure: MeasureId | null;
  today: (Value & { sets: number }) | null;
  last: ({ date: string; where: "class" | "gym" } & Value) | null;
  change: Change | null;
  verdict: Verdict | null;
  via?: string; // the tie-breaker that decided it
  vs_similar?: { date: string; where: "class" | "gym"; change: Change; verdict: Verdict; via?: string; estimated?: true } & Value;
  not_compared?: string;
  pr?: { kind: "e1rm" | "weight_for_reps" | "reps" | "hold" | "assistance"; detail?: string };
  trend: Trend | null;
  estimated?: true;
}
export interface Trend {
  measure: MeasureId; unit: Unit; sessions: number;
  first: { date: string; value: number }; peak: { date: string; value: number }; last: { date: string; value: number };
  direction: "up" | "down" | "flat"; note: string;
}

type Opts = { type: string | null; title?: string };
export type Kind = "weighted" | "assisted" | "bodyweight" | "hold" | "cardio";

const working = (s: ExerciseSession) => s.sets.filter(isWorkingSet);
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const totalReps = (s: ExerciseSession) => sum(working(s).map((x) => x.reps));
const bestSetReps = (s: ExerciseSession) => Math.max(0, ...working(s).map((x) => x.reps ?? 0));
const longestHold = (s: ExerciseSession) => Math.max(0, ...working(s).map((x) => x.duration_s ?? 0));
const totalTime = (s: ExerciseSession) => sum(working(s).map((x) => x.duration_s));
const totalDistance = (s: ExerciseSession) => sum(working(s).map((x) => x.distance_m));
const e1rmOf = (s: ExerciseSession) => bestE1rmSet(s.sets)?.value ?? null;
const topWeightOf = (s: ExerciseSession) => { const t = topSet(s.sets); return t && (t.weight_kg ?? 0) > 0 ? t.weight_kg : null; };
const assistanceOf = (s: ExerciseSession) => { const t = topSet(s.sets, "least_assisted"); return t ? (t.weight_kg ?? 0) : null; };

export function kindOf(type: string | null, today: ExerciseSession): Kind {
  switch (type) {
    case "weight_reps": case "bodyweight_weighted": return "weighted";
    case "bodyweight_assisted": return "assisted";
    case "reps_only": return "bodyweight";
    case "duration": case "weight_duration": return "hold";
    case "distance_duration": case "short_distance_weight": return "cardio";
  }
  const w = working(today);
  if (w.some((s) => (s.weight_kg ?? 0) > 0)) return "weighted";
  if (w.some((s) => (s.reps ?? 0) > 0)) return "bodyweight";
  if (w.some((s) => (s.distance_m ?? 0) > 0)) return "cardio";
  return "hold";
}

interface Spec {
  id: MeasureId; unit: Unit; lowerBetter: boolean; threshold: number;
  value: (s: ExerciseSession) => number | null;
  tie?: { id: string; value: (s: ExerciseSession) => number | null; threshold: number };
  bestReps?: (s: ExerciseSession) => number | null; // for the like-for-like rule
}
const bestE1rmReps = (s: ExerciseSession) => bestE1rmSet(s.sets)?.set.reps ?? null;
const topReps = (s: ExerciseSession) => topSet(s.sets)?.reps ?? null;

const isRunning = (title?: string) => /\b(run|running|treadmill|jog|jogging)\b/i.test(title ?? "");
const paceOf = (s: ExerciseSession, title?: string): number | null => {
  const d = totalDistance(s), t = totalTime(s);
  if (!(d > 0 && t > 0)) return null;
  return isRunning(title) ? t / 60 / (d / 1609.344) : (t / d) * 500;
};

function spec(id: MeasureId, title?: string): Spec {
  switch (id) {
    case "e1rm": return { id, unit: "kg", lowerBetter: false, threshold: THRESHOLDS.e1rm, value: e1rmOf, tie: { id: "top_weight", value: topWeightOf, threshold: THRESHOLDS.weight }, bestReps: bestE1rmReps };
    case "weight": return { id, unit: "kg", lowerBetter: false, threshold: THRESHOLDS.weight, value: topWeightOf, tie: { id: "total_reps", value: (s) => totalReps(s) || null, threshold: THRESHOLDS.reps }, bestReps: topReps };
    case "assistance": return { id, unit: "kg", lowerBetter: true, threshold: THRESHOLDS.weight, value: assistanceOf, tie: { id: "total_reps", value: (s) => totalReps(s) || null, threshold: THRESHOLDS.reps } };
    case "reps": return { id, unit: "reps", lowerBetter: false, threshold: THRESHOLDS.reps, value: (s) => totalReps(s) || null, tie: { id: "best_set", value: (s) => bestSetReps(s) || null, threshold: THRESHOLDS.reps } };
    case "hold": return { id, unit: "s", lowerBetter: false, threshold: THRESHOLDS.hold, value: (s) => longestHold(s) || null, tie: { id: "total_time", value: (s) => totalTime(s) || null, threshold: THRESHOLDS.hold } };
    case "pace": return { id, unit: isRunning(title) ? "min_per_mile" : "sec_per_500m", lowerBetter: true, threshold: THRESHOLDS.pace, value: (s) => paceOf(s, title) };
    case "time": return { id, unit: "s", lowerBetter: true, threshold: THRESHOLDS.time, value: (s) => totalTime(s) || null };
    case "calories": return { id, unit: "cal", lowerBetter: false, threshold: THRESHOLDS.calories, value: (s) => s.calories };
  }
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function judge(today: number, last: number, sp: { lowerBetter: boolean; threshold: number }): Compared {
  const abs = today - last;
  const pct = last !== 0 ? (abs / Math.abs(last)) * 100 : null;
  const big = pct === null ? abs !== 0 : Math.abs(pct) >= sp.threshold;
  const verdict: Verdict = !big ? "same" : (abs > 0) !== sp.lowerBetter ? "better" : "worse";
  return { change: { abs: round(abs, 3), pct: pct === null ? null : round(pct, 2) }, verdict };
}

// The measure to compare TODAY with ONE earlier session, or why there isn't one.
function pickMeasure(kind: Kind, a: ExerciseSession, b: ExerciseSession | null, title?: string): { id: MeasureId } | { id: null; reason: string } {
  const both = (f: (s: ExerciseSession) => number | null) => f(a) !== null && (b === null || f(b) !== null);
  switch (kind) {
    case "weighted":
      if (both(e1rmOf)) return { id: "e1rm" };
      if (both(topWeightOf)) return { id: "weight" };
      return both((s) => totalReps(s) || null) ? { id: "reps" } : { id: null, reason: "no weight or reps on both sessions" };
    case "assisted": return both(assistanceOf) ? { id: "assistance" } : { id: null, reason: "no assistance weight on both sessions" };
    case "bodyweight": return both((s) => totalReps(s) || null) ? { id: "reps" } : { id: null, reason: "no reps on both sessions" };
    case "hold": return both((s) => longestHold(s) || null) ? { id: "hold" } : { id: null, reason: "no hold time on both sessions" };
    case "cardio": {
      if (b === null) return a.calories !== null && totalTime(a) > 0 ? { id: "time" } : paceOf(a, title) !== null ? { id: "pace" } : { id: null, reason: "no time or calories" };
      const da = totalDistance(a), db = totalDistance(b), ta = totalTime(a), tb = totalTime(b);
      if (da > 0 && db > 0 && ta > 0 && tb > 0) {
        const ratio = da / db;
        if (ratio < DISTANCE_RATIO[0] || ratio > DISTANCE_RATIO[1]) return { id: null, reason: `distance ${Math.round(da)} m today vs ${Math.round(db)} m last time` };
        return { id: "pace" };
      }
      if (a.calories !== null && b.calories !== null && ta > 0 && tb > 0) {
        if (Math.abs(a.calories - b.calories) / b.calories * 100 <= SAME_WITHIN_PCT) return { id: "time" };
        if (Math.abs(ta - tb) / tb * 100 <= SAME_WITHIN_PCT) return { id: "calories" };
        return { id: null, reason: "calories and time both differ" };
      }
      return { id: null, reason: "no time or calories on both sessions (distance only): board completion covers it" };
    }
  }
}

function compareValues(sp: Spec, today: ExerciseSession, other: ExerciseSession): Compared | null {
  const a = sp.value(today), b = sp.value(other);
  if (a === null || b === null) return null;
  const primary = judge(a, b, sp);
  if (primary.verdict === "same" && sp.tie) {
    const ta = sp.tie.value(today), tb = sp.tie.value(other);
    if (ta !== null && tb !== null) {
      const t = judge(ta, tb, { lowerBetter: false, threshold: sp.tie.threshold });
      if (t.verdict !== "same") return { change: t.change, verdict: t.verdict, via: sp.tie.id };
    }
  }
  return primary;
}

const valueOf = (sp: Spec, s: ExerciseSession): Value => ({ value: sp.value(s) === null ? null : round(sp.value(s)!, 3), unit: sp.unit });
const lastOf = (s: ExerciseSession, sp: Spec) => ({ date: s.date, where: s.where, ...valueOf(sp, s) });

function prFor(kind: Kind, today: ExerciseSession, earlier: ExerciseSession[]): Comparison["pr"] {
  if (earlier.length === 0 || today.complex) return undefined;
  if (kind === "weighted") {
    const e = e1rmOf(today), prior = earlier.map(e1rmOf).filter((x): x is number => x !== null);
    if (e !== null && prior.length > 0 && e > Math.max(...prior)) return { kind: "e1rm" };
    const best = topSet(today.sets);
    if (best && (best.weight_kg ?? 0) > 0 && (best.reps ?? 0) > 0) {
      const w = earlier.flatMap((s) => working(s)).filter((x) => (x.reps ?? 0) >= best.reps! && (x.weight_kg ?? 0) > 0).map((x) => x.weight_kg!);
      if (w.length > 0 && best.weight_kg! > Math.max(...w)) return { kind: "weight_for_reps", detail: `${best.reps} reps` };
    }
  } else if (kind === "bodyweight") {
    const prior = earlier.map(bestSetReps);
    if (bestSetReps(today) > Math.max(...prior)) return { kind: "reps" };
  } else if (kind === "hold") {
    const prior = earlier.map(longestHold);
    if (longestHold(today) > Math.max(...prior)) return { kind: "hold" };
  } else if (kind === "assisted") {
    const t = assistanceOf(today), prior = earlier.map(assistanceOf).filter((x): x is number => x !== null);
    if (t !== null && prior.length > 0 && t < Math.min(...prior)) return { kind: "assistance" };
  }
  return undefined;
}

function trendFor(sp: Spec, today: ExerciseSession, earlier: ExerciseSession[]): Trend | null {
  const since = addDays(today.date, -TREND_DAYS);
  const pts = [...earlier, today].filter((s) => s.date >= since && s.date <= today.date)
    .sort((x, y) => x.date.localeCompare(y.date)).map((s) => ({ date: s.date, value: sp.value(s) })).filter((p): p is { date: string; value: number } => p.value !== null);
  if (pts.length < TREND_MIN_SESSIONS) return null;
  const peak = pts.reduce((a, b) => (sp.lowerBetter ? (b.value < a.value ? b : a) : (b.value > a.value ? b : a)));
  const first = pts[0], last = pts[pts.length - 1];
  const pct = first.value !== 0 ? ((last.value - first.value) / Math.abs(first.value)) * 100 : 0;
  const r = (p: { date: string; value: number }) => ({ date: p.date, value: round(p.value, 3) });
  return {
    measure: sp.id, unit: sp.unit, sessions: pts.length, first: r(first), peak: r(peak), last: r(last),
    direction: Math.abs(pct) < sp.threshold ? "flat" : pct > 0 ? "up" : "down",
    note: "first / peak / last of the same measure over the last 90 days; a straight-line fit would mislead when progress rose then fell.",
  };
}

export function compareExercise(today: ExerciseSession, history: ExerciseSession[], opts: Opts): Comparison {
  const kind = kindOf(opts.type, today);
  const earlier = history.filter((h) => h.date < today.date || (h.date === today.date && h.wid !== today.wid))
    .sort((a, b) => a.date.localeCompare(b.date) || a.wid.localeCompare(b.wid));
  const base: Comparison = { first_time: earlier.length === 0, measure: null, today: null, last: null, change: null, verdict: null, trend: null };
  const solo = pickMeasure(kind, today, null, opts.title);
  const soloSpec = solo.id ? spec(solo.id, opts.title) : null;
  if (soloSpec) base.today = { ...valueOf(soloSpec, today), sets: working(today).length };
  if (soloSpec) base.measure = soloSpec.id;
  if (earlier.length === 0) return base;

  const mostRecent = earlier[earlier.length - 1];
  // A complex is compared only with the same complex (and straight sets only with straight sets).
  const pool = earlier.filter((h) => (h.complex ?? null) === (today.complex ?? null));
  const pr = prFor(kind, today, earlier);
  if (pr) base.pr = pr;
  if (soloSpec) base.trend = trendFor(soloSpec, today, pool);
  if (pool.length === 0) {
    const sp = soloSpec;
    return { ...base, last: sp ? lastOf(mostRecent, sp) : null, not_compared: today.complex ? `the ${today.complex} complex has no earlier session with the same complex` : "earlier sessions were complexes, not straight sets" };
  }
  const last = pool[pool.length - 1];
  const picked = pickMeasure(kind, today, last, opts.title);
  if (!picked.id) {
    return { ...base, measure: soloSpec?.id ?? null, last: soloSpec ? lastOf(last, soloSpec) : null, not_compared: picked.reason, ...(today.assumed || last.assumed ? { estimated: true as const } : {}) };
  }
  const sp = spec(picked.id, opts.title);
  base.measure = sp.id;
  base.today = { ...valueOf(sp, today), sets: working(today).length };
  base.trend = trendFor(sp, today, pool);
  base.last = lastOf(last, sp);
  const estimated = today.assumed || last.assumed ? { estimated: true as const } : {};

  // Like for like: the best sets must be within 3 reps of each other (weighted measures only).
  if (sp.bestReps) {
    const tr = sp.bestReps(today), lr = sp.bestReps(last);
    if (tr !== null && lr !== null && Math.abs(tr - lr) > REP_WINDOW) {
      const out: Comparison = { ...base, not_compared: `${tr} reps today vs ${lr} last time`, ...estimated };
      const since = addDays(today.date, -SIMILAR_DAYS);
      for (let i = pool.length - 2; i >= 0; i--) {
        const cand = pool[i];
        if (cand.date < since) break;
        const cm = pickMeasure(kind, today, cand, opts.title);
        if (!cm.id) continue;
        const cs = spec(cm.id, opts.title);
        const cr = cs.bestReps?.(cand), tr2 = cs.bestReps?.(today);
        if (cr === null || cr === undefined || tr2 === null || tr2 === undefined || Math.abs(tr2 - cr) > REP_WINDOW) continue;
        const cmp = compareValues(cs, today, cand);
        if (!cmp) continue;
        out.vs_similar = { date: cand.date, where: cand.where, ...valueOf(cs, cand), change: cmp.change, verdict: cmp.verdict, ...(cmp.via ? { via: cmp.via } : {}), ...(today.assumed || cand.assumed ? { estimated: true as const } : {}) };
        break;
      }
      return out;
    }
  }
  const cmp = compareValues(sp, today, last);
  if (!cmp) return { ...base, not_compared: "no comparable value", ...estimated };
  return { ...base, change: cmp.change, verdict: cmp.verdict, ...(cmp.via ? { via: cmp.via } : {}), ...estimated };
}
