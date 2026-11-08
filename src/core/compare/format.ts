import { bestE1rmSet, isWorkingSet, topSet } from "../metrics";
import { outWeight, type Units } from "../units";
import { kindOf, type Change, type Comparison, type ExerciseSession, type MeasureId } from "./exercise";

// What Claude reads: values in the user's units, a plain summary of each session, and ONE sentence made only of the
// numbers, so the coaching note can quote it and can't invent a comparison.

const round1 = (n: number) => Math.round(n * 10) / 10;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const w = (kg: number | null | undefined, units: Units) => String(outWeight(kg ?? 0, units));

export function sessionSummary(s: ExerciseSession, type: string | null, units: Units): string {
  const work = s.sets.filter(isWorkingSet);
  const n = work.length;
  const kind = kindOf(type, s);
  if (kind === "weighted") {
    const t = topSet(s.sets);
    if (!t) return `${n} set${n === 1 ? "" : "s"}`;
    const e = bestE1rmSet(s.sets);
    return `${n} set${n === 1 ? "" : "s"}, best ${w(t.weight_kg, units)} ${units} x ${t.reps ?? 0}${e ? ` (estimated max ${w(e.value, units)} ${units})` : ""}`;
  }
  if (kind === "assisted") {
    const t = topSet(s.sets, "least_assisted");
    return t ? `${n} set${n === 1 ? "" : "s"}, best ${w(t.weight_kg, units)} ${units} assistance x ${t.reps ?? 0}` : `${n} sets`;
  }
  if (kind === "bodyweight") {
    const reps = work.reduce((a, x) => a + (x.reps ?? 0), 0), best = Math.max(0, ...work.map((x) => x.reps ?? 0));
    return `${reps} reps in total (best set ${best})`;
  }
  if (kind === "hold") {
    const longest = Math.max(0, ...work.map((x) => x.duration_s ?? 0)), total = work.reduce((a, x) => a + (x.duration_s ?? 0), 0);
    return `longest hold ${longest} s (${total} s in total)`;
  }
  const dist = work.reduce((a, x) => a + (x.distance_m ?? 0), 0), time = work.reduce((a, x) => a + (x.duration_s ?? 0), 0);
  const parts: string[] = [];
  if (dist > 0) parts.push(time > 0 ? `${Math.round(dist)} m in ${clock(time)}` : s.calories === null ? `${Math.round(dist)} m (no time)` : `${Math.round(dist)} m`);
  else if (time > 0) parts.push(clock(time));
  if (s.calories !== null) parts.push(`${Math.round(s.calories)} cal`);
  return parts.join(", ") || "no countable work";
}

const MEASURE_LABEL: Record<MeasureId, string> = {
  e1rm: "estimated max", weight: "top weight", assistance: "assistance", reps: "total reps", hold: "longest hold", pace: "pace", time: "time", calories: "calories",
};
const UNIT_TEXT: Record<string, (units: Units) => string> = {
  kg: (u) => u, reps: () => "reps", s: () => "s", sec_per_500m: () => "s per 500 m", min_per_mile: () => "min per mile", cal: () => "cal",
};

const conv = (unit: string | undefined, v: number | null, units: Units): number | null => (v === null ? null : unit === "kg" ? (outWeight(v, units) as number) : round1(v));
const convChange = (unit: string | undefined, c: Change | null, units: Units) =>
  c === null ? null : { abs: conv(unit, c.abs, units) as number, pct: c.pct === null ? null : round1(c.pct) };

export interface DescribeOpts { type: string | null; title: string; units: Units }

export function describeComparison(c: Comparison, today: ExerciseSession, history: ExerciseSession[], o: DescribeOpts) {
  const unit = c.today?.unit;
  const find = (date: string, where: string) => history.find((h) => h.date === date && h.where === where);
  const lastSession = c.last ? find(c.last.date, c.last.where) : undefined;
  const todayOut = c.today ? { value: conv(unit, c.today.value, o.units), summary: sessionSummary(today, o.type, o.units) } : { summary: sessionSummary(today, o.type, o.units) };
  const lastOut = c.last ? { date: c.last.date, where: c.last.where, value: conv(c.last.unit, c.last.value, o.units), summary: lastSession ? sessionSummary(lastSession, o.type, o.units) : null } : null;
  const unitText = unit ? UNIT_TEXT[unit](o.units) : "";
  const label = c.measure ? MEASURE_LABEL[c.measure] : "";

  let line: string;
  if (c.first_time) line = `${o.title}: first time logged (${todayOut.summary})`;
  else if (c.not_compared || c.verdict === null) {
    line = `${o.title}: not compared (${c.not_compared ?? "no comparable value"}); today ${todayOut.summary}${lastOut?.summary ? `; last time ${lastOut.summary} on ${lastOut.date}` : ""}`;
  } else {
    const pct = c.change?.pct;
    const sign = pct === null || pct === undefined ? "" : `${pct >= 0 ? "+" : ""}${round1(pct)}%`;
    line = `${o.title}: ${label} ${todayOut.value} ${unitText} vs ${lastOut?.value} ${unitText} on ${lastOut?.date}`;
    const tail = [sign, ...(c.pr ? ["PR"] : [])].filter(Boolean).join(", ");
    if (tail) line += ` (${tail})`;
    else if (c.verdict === "same") line += " (about the same)";
  }
  if (c.estimated) line += " (estimated)";

  const simSession = c.vs_similar ? find(c.vs_similar.date, c.vs_similar.where) : undefined;
  return {
    exercise: o.title, first_time: c.first_time, measure: c.measure, unit: unitText || null,
    verdict: c.verdict, ...(c.via ? { via: c.via } : {}),
    today: todayOut, last: lastOut, change: convChange(unit, c.change, o.units),
    ...(c.vs_similar ? { vs_similar: { date: c.vs_similar.date, where: c.vs_similar.where, value: conv(c.vs_similar.unit, c.vs_similar.value, o.units), summary: simSession ? sessionSummary(simSession, o.type, o.units) : null, change: convChange(c.vs_similar.unit, c.vs_similar.change, o.units), verdict: c.vs_similar.verdict } } : {}),
    ...(c.not_compared ? { not_compared: c.not_compared } : {}),
    ...(c.pr ? { pr: c.pr } : {}),
    trend: c.trend ? { ...c.trend, unit: UNIT_TEXT[c.trend.unit](o.units), first: { ...c.trend.first, value: conv(c.trend.unit, c.trend.first.value, o.units) }, peak: { ...c.trend.peak, value: conv(c.trend.unit, c.trend.peak.value, o.units) }, last: { ...c.trend.last, value: conv(c.trend.unit, c.trend.last.value, o.units) } } : null,
    ...(c.estimated ? { estimated: true as const } : {}),
    line,
  };
}
