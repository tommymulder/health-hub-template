import type { Sql } from "../db";
import { localDate } from "../time";
import { ToolError } from "../tools/context";

export type WindowSource = "explicit" | "oura_workout" | "heart_rate" | "photo_time";
export interface ClassWindow { start: Date; end: Date; source: WindowSource; local_date: string; detail?: string }

const DEFAULT_MIN = 50;
const MIN = 60_000;
// Oura activities that could be a class; walking, house work, cycling etc. are not.
const CLASS_ACTIVITIES = ["fitnessClass", "strengthTraining", "cardiovascularExercise", "hiit", "crossTraining", "functionalStrengthTraining"];
const PRIORITY: Record<string, number> = { fitnessClass: 0, strengthTraining: 1, hiit: 1, crossTraining: 1, functionalStrengthTraining: 1, cardiovascularExercise: 2 };

export interface HrPt { t: number; bpm: number }

// A sustained stretch of raised heart rate near `aroundMs`: consecutive samples >= minBpm with gaps <= maxGapMin,
// lasting >= minMinutes. Returns the stretch closest to the hint. Pure.
export function findRaisedHrStretch(
  points: HrPt[], aroundMs: number,
  o: { minBpm: number; minMinutes?: number; maxGapMin?: number; withinMs?: number },
): { start: number; end: number } | null {
  const minLen = (o.minMinutes ?? 25) * MIN, maxGap = (o.maxGapMin ?? 6) * MIN, within = o.withinMs ?? 3 * 60 * MIN;
  const hi = points.filter((p) => p.bpm >= o.minBpm && Math.abs(p.t - aroundMs) <= within).sort((a, b) => a.t - b.t);
  const stretches: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const p of hi) {
    if (cur && p.t - cur.end <= maxGap) cur.end = p.t;
    else { if (cur) stretches.push(cur); cur = { start: p.t, end: p.t }; }
  }
  if (cur) stretches.push(cur);
  const ok = stretches.filter((s) => s.end - s.start >= minLen);
  if (ok.length === 0) return null;
  const dist = (s: { start: number; end: number }) => (aroundMs >= s.start && aroundMs <= s.end ? 0 : Math.min(Math.abs(aroundMs - s.start), Math.abs(aroundMs - s.end)));
  return ok.sort((a, b) => dist(a) - dist(b))[0];
}

// Where did the class happen? Explicit start beats everything; then Oura's own record of the workout (more accurate
// than the photo time: the photo was taken at 6:55 and the class ran 7:02-8:00); then a heart-rate stretch; then the photo time.
export async function resolveClassWindow(
  sql: Sql,
  i: { start_at?: string; duration_min?: number; photo_time?: string; date?: string },
  tz: string, hrMax = 190,
): Promise<ClassWindow> {
  const dur = (i.duration_min ?? DEFAULT_MIN) * MIN;
  const parse = (v: string, what: string) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ToolError(`${what} "${v}" isn't a valid date-time. Use ISO format with an offset, e.g. 2026-07-22T07:00:00-07:00.`);
    return d;
  };

  if (i.start_at) {
    const start = parse(i.start_at, "start_at");
    return { start, end: new Date(start.getTime() + dur), source: "explicit", local_date: localDate(start, tz) };
  }

  const hint = i.photo_time ? parse(i.photo_time, "photo_time") : null;
  const day = hint ? localDate(hint, tz) : i.date;
  if (!day) throw new ToolError("I can't tell when the class was. Give start_at, photo_time (when the board photo was taken) or date.");

  const docs = await sql<{ start_at: Date; end_at: Date; data: { activity?: string; source?: string } }[]>`
    select start_at, end_at, data from oura_documents where collection = 'workout' and day = ${day} and start_at is not null and end_at is not null`;
  const cands = docs.filter((d) => CLASS_ACTIVITIES.includes(String(d.data.activity)))
    .filter((d) => !hint || Math.abs(d.start_at.getTime() - hint.getTime()) <= 90 * MIN)
    .sort((a, b) => (PRIORITY[String(a.data.activity)] ?? 9) - (PRIORITY[String(b.data.activity)] ?? 9) ||
      (hint ? Math.abs(a.start_at.getTime() - hint.getTime()) - Math.abs(b.start_at.getTime() - hint.getTime()) : 0));
  if (cands[0]) {
    return { start: cands[0].start_at, end: cands[0].end_at, source: "oura_workout", local_date: day, detail: `Oura ${cands[0].data.activity} (${cands[0].data.source ?? "?"})` };
  }

  if (hint) {
    const around = hint.getTime();
    const hr = await sql<{ ts: Date; bpm: number }[]>`select ts, bpm from hr_samples where ts between ${new Date(around - 4 * 60 * MIN)} and ${new Date(around + 4 * 60 * MIN)} order by ts`;
    const s = findRaisedHrStretch(hr.map((r) => ({ t: r.ts.getTime(), bpm: r.bpm })), around, { minBpm: Math.round(hrMax * 0.55) });
    if (s) return { start: new Date(s.start), end: new Date(s.end), source: "heart_rate", local_date: day, detail: "a sustained raised-heart-rate stretch" };
    return { start: hint, end: new Date(hint.getTime() + dur), source: "photo_time", local_date: day, detail: `photo time + ${i.duration_min ?? DEFAULT_MIN} min (no Oura record found)` };
  }
  throw new ToolError(`I couldn't find the class in Oura for ${day} and there's no photo time to go on. Give start_at.`);
}
