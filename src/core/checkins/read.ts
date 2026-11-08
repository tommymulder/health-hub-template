import { WORKING_SET_TYPES } from "../metrics";
import { addDays, localDateTime, wallClockToInstant } from "../time";
import { analyseDay, nightsFromDocs, type Press } from "../events/night";
import { loadPresses, nightView, trackingStart } from "../events/read";
import { num, resolveWindow, todayLocal, type ToolCtx } from "../tools/context";
import { pickNight } from "../tools/recovery";
import { splitFeel, type RatedMorning } from "./feel";
import { hoursAfterWaking, ratingLabel } from "./validate";

type Doc = Record<string, unknown>;
interface Row { collection: string; day: string; start_at: Date | null; end_at: Date | null; data: Doc }
interface Stored {
  day: string;
  rating: number;
  note: string | null;
  logged_at: Date;
  source: string;
  recalled: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const hours = (sec: unknown) => (num(sec) === null ? null : round1((sec as number) / 3600));
const mins = (sec: unknown) => (num(sec) === null ? null : Math.round((sec as number) / 60));

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tagLabel(data: Doc): string {
  const name = typeof data.custom_name === "string" && data.custom_name.trim() ? data.custom_name.trim() : null;
  const code = typeof data.tag_type_code === "string" && data.tag_type_code.trim() ? data.tag_type_code.trim() : null;
  const base = name ?? code ?? "tag";
  const comment = typeof data.comment === "string" ? data.comment.trim() : "";
  return comment ? `${base}: ${comment.slice(0, 80)}` : base;
}

function classMinutes(row: Row): number {
  const s = Date.parse(String(row.data.start_datetime ?? ""));
  const e = Date.parse(String(row.data.end_datetime ?? ""));
  if (Number.isFinite(s) && Number.isFinite(e)) return Math.max(0, Math.round((e - s) / 60000));
  const start = asDate(row.start_at), end = asDate(row.end_at);
  if (start && end) return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return 0;
}

async function load(ctx: ToolCtx, start: string, end: string) {
  const from = addDays(start, -1); // previous day's load sits on the day before the wake-up date
  const [checkins, docs, lifting] = await Promise.all([
    ctx.sql<Stored[]>`
      select day::text as day, rating, note, logged_at, source, recalled
      from morning_checkins where day between ${start} and ${end}
      order by day desc`,
    ctx.sql<Row[]>`
      select collection, day::text as day, start_at, end_at, data from oura_documents
      where day between ${from} and ${end}
        and collection in ('sleep', 'daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'workout', 'enhanced_tag')`,
    ctx.sql<{ day: string; n: number }[]>`
      select local_date::text as day, count(*)::int as n from workouts
      where not deleted and local_date between ${from} and ${end}
        and id not in (select hevy_workout_id from class_sessions where hevy_workout_id is not null)
        and exists (
          select 1 from workout_exercises e
          join sets s on s.workout_exercise_id = e.id
          where e.workout_id = workouts.id and s.set_type in ${ctx.sql([...WORKING_SET_TYPES])}
        )
      group by 1`,
  ]);
  const dayStart = (d: string) => wallClockToInstant(`${d}T00:00:00Z`, ctx.timezone);
  const presses = await loadPresses(ctx, dayStart(addDays(start, -2)), dayStart(addDays(end, 2)));
  return { checkins, docs, lifting: new Map(lifting.map((r) => [r.day, r.n])), trips: { presses, trackedFrom: await trackingStart(ctx) } };
}

interface Trips { presses: Press[]; trackedFrom: Date | null }

function pair(ctx: ToolCtx, stored: Stored, docs: Row[], lifting: Map<string, number>, trips: Trips): { view: Record<string, unknown>; rated: RatedMorning; hasNight: boolean } {
  const sleeps = docs.filter((d) => d.collection === "sleep" && d.day === stored.day);
  const { night } = pickNight(sleeps as never);
  const dailySleep = docs.find((d) => d.collection === "daily_sleep" && d.day === stored.day)?.data;
  const readiness = docs.find((d) => d.collection === "daily_readiness" && d.day === stored.day)?.data;
  const wakeAt = asDate(night?.end_at ?? null);
  const loggedAt = asDate(stored.logged_at)!;
  const after = hoursAfterWaking(loggedAt, wakeAt);
  const prev = addDays(stored.day, -1);
  const classes = docs.filter((d) => d.collection === "workout" && d.day === prev && d.data.activity === "fitnessClass");
  const steps = num(docs.find((d) => d.collection === "daily_activity" && d.day === prev)?.data.steps);
  const tags = docs.filter((d) => d.collection === "enhanced_tag" && d.day === prev).map((d) => tagLabel(d.data));
  const stressSummary = docs.find((d) => d.collection === "daily_stress" && d.day === prev)?.data.day_summary;
  const n = night?.data;
  const nightTrips = nightView(analyseDay({ day: stored.day, nights: nightsFromDocs(docs.filter((d) => d.collection === "sleep") as never), presses: trips.presses, trackingStart: trips.trackedFrom, tz: ctx.timezone }), ctx.timezone);
  const sleep = n || dailySleep ? {
    score: num(dailySleep?.score),
    total_hours: hours(n?.total_sleep_duration),
    deep_min: mins(n?.deep_sleep_duration),
    rem_min: mins(n?.rem_sleep_duration),
    efficiency_pct: num(n?.efficiency),
    latency_min: mins(n?.latency),
    bedtime_local: night?.start_at ? localDateTime(night.start_at, ctx.timezone) : null,
    wake_local: wakeAt ? localDateTime(wakeAt, ctx.timezone) : null,
    avg_hrv_ms: num(n?.average_hrv),
    lowest_hr: num(n?.lowest_heart_rate),
    temperature_deviation_c: num(readiness?.temperature_deviation),
  } : null;
  const previous = {
    day: prev,
    classes: classes.length,
    class_minutes: classes.reduce((a, c) => a + classMinutes(c), 0),
    lifting_sessions: lifting.get(prev) ?? 0,
    steps,
    stress_summary: typeof stressSummary === "string" ? stressSummary : null,
    tags,
  };
  const rated: RatedMorning = {
    day: stored.day,
    rating: Number(stored.rating),
    hours_after_waking: after,
    sleep_score: sleep?.score ?? null,
    total_hours: sleep?.total_hours ?? null,
    deep_min: sleep?.deep_min ?? null,
    rem_min: sleep?.rem_min ?? null,
    efficiency_pct: sleep?.efficiency_pct ?? null,
    latency_min: sleep?.latency_min ?? null,
    avg_hrv_ms: sleep?.avg_hrv_ms ?? null,
    lowest_hr: sleep?.lowest_hr ?? null,
    temperature_deviation_c: sleep?.temperature_deviation_c ?? null,
    readiness: num(readiness?.score),
    previous_steps: steps,
    previous_classes: classes.length,
    previous_lifting: lifting.get(prev) ?? 0,
  };
  return {
    rated,
    hasNight: !!night,
    view: {
      day: stored.day,
      rating: Number(stored.rating),
      label: ratingLabel(Number(stored.rating)),
      note: stored.note,
      logged_at: localDateTime(loggedAt, ctx.timezone),
      hours_after_waking: after,
      recalled: stored.recalled,
      source: stored.source,
      sleep,
      readiness: num(readiness?.score),
      ...(nightTrips?.bathroom_trips ? { bathroom_trips: { count: nightTrips.bathroom_trips.count, times: nightTrips.bathroom_trips.times } } : {}),
      ...(nightTrips?.ring ? { ring_wake_ups: { wake_ups: nightTrips.ring.wake_ups, longest_unbroken_sleep_min: nightTrips.ring.longest_unbroken_sleep_min } } : {}),
      previous_day: previous,
      ...(sleep ? {} : { sleep_note: "No main sleep (long_sleep) is stored for this wake-up date. Naps are not used." }),
    },
  };
}

export async function getCheckins(ctx: ToolCtx, input: { days?: number }) {
  const { start, end } = resolveWindow(ctx, { days: input.days }, 30);
  const today = todayLocal(ctx);
  const { checkins, docs, lifting, trips } = await load(ctx, start, end);
  const days = checkins.map((c) => pair(ctx, c, docs, lifting, trips).view);
  return {
    checked_in_today: checkins.some((c) => c.day === today),
    window: { start, end },
    note: "Each rating is matched only to that date's longest long_sleep. Naps are ignored, even when Oura files them on the same day. hours_after_waking is logged_at minus that night's wake time. recalled means the rating was logged on a later day. bathroom_trips (when tracking has started) and ring_wake_ups are that night's trips from the Action Button and the ring's wake-ups (Oura can miss very short wakings).",
    days,
  };
}

export async function getFeelVsRing(ctx: ToolCtx, input: { days?: number; on_time_only?: boolean }) {
  const { start, end } = resolveWindow(ctx, { days: input.days }, 90);
  const { checkins, docs, lifting, trips } = await load(ctx, start, end);
  const paired = checkins.map((c) => pair(ctx, c, docs, lifting, trips));
  // A morning with no main sleep stored (ring off, or not synced yet) keeps its rating
  // but sits out the analysis: there's nothing from the ring to compare it with.
  const rated = paired.filter((p) => p.hasNight).map((p) => p.rated);
  const split = splitFeel(rated, !!input.on_time_only);
  return {
    window: { start, end },
    left_out_no_main_sleep: paired.length - rated.length,
    ...split,
    rating_3_excluded_from_split: true,
    good_vs_rough: "Rating 3 (OK) is in the correlations and the quartile cutoffs, and in neither the good (4-5) nor the rough (1-2) average.",
  };
}
