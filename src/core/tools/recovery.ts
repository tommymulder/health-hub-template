import { addDays, localDateTime, wallClockToInstant } from "../time";
import { BASELINE_DAYS, baselineBefore, pctVsBaseline } from "../oura/recovery";
import { ToolError, todayLocal, type ToolCtx } from "./context";
import { ratingLabel } from "../checkins/validate";
import { moduleOn } from "../modules";
import { resolveWindow } from "./workouts";
import { avg7, loadScale } from "./apple";
import { outWeight } from "../units";
import { loadHeartRate, zonesOf } from "../hr/window";
import { heartRateStats, zoneLabels } from "../oura/hr";
import { analyseDay, nightsFromDocs } from "../events/night";
import { daytimeView, loadPresses, nightView, RING_NOTE, trackingStart } from "../events/read";

type Doc = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const hours = (sec: unknown) => (num(sec) === null ? null : round1((sec as number) / 3600));
const mins = (sec: unknown) => (num(sec) === null ? null : Math.round((sec as number) / 60));
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

interface Row { collection: string; day: string; start_at: Date | null; end_at: Date | null; data: Doc }

async function loadRange(ctx: ToolCtx, from: string, to: string): Promise<Row[]> {
  return ctx.sql<Row[]>`
    select collection, day::text as day, start_at, end_at, data from oura_documents
    where day between ${from} and ${to}
      and collection in ('daily_readiness','daily_sleep','daily_activity','daily_stress','daily_resilience','daily_spo2','sleep')
    order by day`;
}

// The main night of a day: the longest long_sleep. Everything else on that day is a nap.
export function pickNight(sleeps: Row[]): { night: Row | null; napMin: number } {
  const long = sleeps.filter((r) => r.data.type === "long_sleep").sort((a, b) => (num(b.data.total_sleep_duration) ?? 0) - (num(a.data.total_sleep_duration) ?? 0));
  const night = long[0] ?? null;
  const napSec = sleeps.filter((r) => r !== night).reduce((n, r) => n + (num(r.data.total_sleep_duration) ?? 0), 0);
  return { night, napMin: Math.round(napSec / 60) };
}

export async function getRecovery(ctx: ToolCtx, input: { days?: number }) {
  const { start, end } = resolveWindow(ctx, { days: input.days }, 14);
  const checkinsOn = moduleOn(ctx, "checkins"), eventsOn = moduleOn(ctx, "events");
  const morning_checkin = checkinsOn ? await todaysCheckin(ctx) : null;
  const rows = await loadRange(ctx, addDays(start, -BASELINE_DAYS), end);
  if (rows.length === 0) throw new ToolError("No Oura data is stored yet. Ask for connect_oura to connect it, then run sync_now.");

  const by = (c: string) => new Map(rows.filter((r) => r.collection === c).map((r) => [r.day, r.data]));
  const readiness = by("daily_readiness"), dailySleep = by("daily_sleep"), activity = by("daily_activity");
  const stress = by("daily_stress"), resilience = by("daily_resilience"), spo2 = by("daily_spo2");
  const sleepsByDay = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.collection === "sleep")) sleepsByDay.set(r.day, [...(sleepsByDay.get(r.day) ?? []), r]);
  const nights = new Map([...sleepsByDay].map(([d, list]) => [d, pickNight(list)]));

  // Bathroom trips (Phase 17): raw presses for the window, matched to the ring's wake-ups per day.
  const dayStart = (d: string) => wallClockToInstant(`${d}T00:00:00Z`, ctx.timezone);
  const presses = eventsOn ? await loadPresses(ctx, dayStart(addDays(start, -2)), dayStart(addDays(end, 2))) : [];
  const trackedFrom = eventsOn ? await trackingStart(ctx) : null;
  const sleepNights = nightsFromDocs(rows.filter((x) => x.collection === "sleep"));

  // 60-day-median baselines for the metrics that matter, so "HRV 26" can be read as "-9% vs your normal".
  const series = (get: (day: string) => number | null) => {
    const m = new Map<string, number>();
    for (let d = addDays(start, -BASELINE_DAYS); d <= end; d = addDays(d, 1)) { const v = get(d); if (v !== null) m.set(d, v); }
    return m;
  };
  const metric = {
    readiness: series((d) => num(readiness.get(d)?.score)),
    sleepScore: series((d) => num(dailySleep.get(d)?.score)),
    hrv: series((d) => num(nights.get(d)?.night?.data.average_hrv)),
    lowestHr: series((d) => num(nights.get(d)?.night?.data.lowest_heart_rate)),
    sleepH: series((d) => hours(nights.get(d)?.night?.data.total_sleep_duration)),
    steps: series((d) => num(activity.get(d)?.steps)),
  };
  const vs = (m: Map<string, number>, day: string) => pctVsBaseline(m.get(day) ?? null, baselineBefore(m, day));

  // Weight (Apple Health scale) joins by day; absent until Health Auto Export has delivered, never an error.
  const scale = await loadScale(ctx, addDays(start, -6), end);
  const weightOn = new Map(scale.days.map((w) => [w.day, w]));

  const days: object[] = [];
  for (let d = end; d >= start; d = addDays(d, -1)) {
    const rd = readiness.get(d), ds = dailySleep.get(d), ac = activity.get(d), st = stress.get(d), rs = resilience.get(d), sp = spo2.get(d);
    const { night, napMin } = nights.get(d) ?? { night: null, napMin: 0 };
    const n = night?.data;
    const wt = weightOn.get(d);
    if (!rd && !ds && !n && !ac && !wt) continue; // a day with nothing recorded (ring off / not synced)
    const trips = analyseDay({ day: d, nights: sleepNights, presses, trackingStart: trackedFrom, tz: ctx.timezone });
    days.push(compact({
      day: d,
      readiness: rd ? compact({ score: num(rd.score), vs_baseline_pct: vs(metric.readiness, d), temperature_deviation_c: num(rd.temperature_deviation), contributors: rd.contributors }) : null,
      sleep: ds || n ? compact({
        score: num(ds?.score), score_vs_baseline_pct: vs(metric.sleepScore, d),
        total_hours: hours(n?.total_sleep_duration), hours_vs_baseline_pct: vs(metric.sleepH, d),
        time_in_bed_hours: hours(n?.time_in_bed), efficiency_pct: num(n?.efficiency), latency_min: mins(n?.latency),
        deep_min: mins(n?.deep_sleep_duration), rem_min: mins(n?.rem_sleep_duration), light_min: mins(n?.light_sleep_duration), awake_min: mins(n?.awake_time),
        avg_hrv_ms: num(n?.average_hrv), hrv_vs_baseline_pct: vs(metric.hrv, d),
        lowest_hr: num(n?.lowest_heart_rate), lowest_hr_vs_baseline_pct: vs(metric.lowestHr, d), avg_hr: num(n?.average_heart_rate),
        bedtime_local: night?.start_at ? localDateTime(night.start_at, ctx.timezone) : null,
        wake_local: night?.end_at ? localDateTime(night.end_at, ctx.timezone) : null,
        naps_min: napMin || null, contributors: ds?.contributors,
      }) : null,
      activity: ac ? compact({ steps: num(ac.steps), steps_vs_baseline_pct: vs(metric.steps, d), active_calories: num(ac.active_calories), score: num(ac.score) }) : null,
      stress: st ? compact({ stress_high_min: mins(st.stress_high), recovery_high_min: mins(st.recovery_high), summary: st.day_summary }) : null,
      resilience: rs ? compact({ level: rs.level }) : null,
      spo2_avg_pct: num((sp?.spo2_percentage as Doc | undefined)?.average),
      weight: wt ? compact({ weight: outWeight(wt.kg, ctx.units), avg_7d: outWeight(avg7(scale.days, d), ctx.units), body_fat_pct: wt.fat === null ? null : round1(wt.fat) }) : null,
      ...(eventsOn ? { night: nightView(trips, ctx.timezone), daytime: daytimeView(trips, ctx.timezone, trackedFrom !== null), wake_day_total: trips.wakeDayTotal } : {}),
    }));
  }
  return {
    window: { start, end },
    ...(checkinsOn ? { morning_checkin } : {}),
    notes: [
      ...(checkinsOn ? [
      "morning_checkin is today's 1-5 wake-up rating (null = not rated yet). If it's null and they're awake, ask how they felt when they woke up BEFORE showing any sleep numbers, then log_checkin.",
      ] : []),
      "HRV is Oura's RMSSD (milliseconds), averaged over the night. vs_baseline_pct compares with the MEDIAN of the previous 60 days (needs 14+ days of history), the user's own rule: a steady baseline that one bad night can't drag.",
      ...(eventsOn ? [RING_NOTE] : []),
      ...(eventsOn ? [
      "`night` and `daytime` hold the bathroom trips they log with a phone button (`night`: trips from bedtime minus an hour to the wake time, with the ring's wake-ups and how they matched; `daytime`: trips after waking, the minutes between them; `wake_day_total` = that night plus that day). A night with no trips is 0 only once tracking has started; a day with no trips is not_tracked, never 0.",
      ] : []),
      "`day` is the day you woke up. Days with no data (ring off or not yet synced) are skipped.",
      "weight is the scale's reading that day (Apple Health) with its 7-day average, in the user's units; see get_body_metrics for the trend.",
    ],
    days,
  };
}

const COLLECTION_NOTE = "Series (heart rate / HRV every 5 minutes, movement, sleep phases) are summarised unless include_series is true.";
function slim(d: Doc, includeSeries: boolean): Doc {
  if (includeSeries) return d;
  const out: Doc = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && v.length > 200) out[k] = `<${v.length} chars omitted>`;
    else if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Doc).items)) out[k] = { interval: (v as Doc).interval, timestamp: (v as Doc).timestamp, items: `<${((v as Doc).items as unknown[]).length} values omitted>` };
    else out[k] = v;
  }
  return out;
}

// Heart rate for each workout: the readings for the whole span load ONCE and are sliced per workout (not 40 queries).
async function addWorkoutHeartRate(ctx: ToolCtx, raw: Doc[], out: Doc[]) {
  const spans = raw.map((d) => [Date.parse(String(d.start_datetime)), Date.parse(String(d.end_datetime))] as const);
  const valid = spans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);
  const points = valid.length ? await loadHeartRate(ctx, new Date(Math.min(...valid.map((v) => v[0]))), new Date(Math.max(...valid.map((v) => v[1])))) : [];
  spans.forEach(([s, e], i) => {
    if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) return;
    const st = heartRateStats(points, s, e, zonesOf(ctx));
    const { z1, z2, z3, z4, z5 } = st.minutes_by_zone;
    out[i] = {
      ...out[i],
      heart_rate: st.samples > 0
        ? { avg: st.avg, min: st.min, max: st.max, samples: st.samples, covered_minutes: st.covered_minutes, window_minutes: st.window_minutes, minutes_by_zone: { below_z1: st.minutes_by_zone.below_z1, z1, z2, z3, z4, z5 } }
        : { samples: 0, note: "No stored heart-rate readings fall inside this workout (ring not worn, not synced yet, or no readings were taken)." },
    };
  });
}

export async function getOuraData(ctx: ToolCtx, input: { collection: string; start?: string; end?: string; include_series?: boolean }) {
  const { start, end } = resolveWindow(ctx, { start: input.start, end: input.end }, 14);
  const rows = await ctx.sql<{ day: string; data: Doc }[]>`
    select day::text as day, data from oura_documents
    where collection = ${input.collection} and day between ${start} and ${end} order by day desc, start_at desc nulls last limit 40`;
  const docs = rows.map((r) => slim(r.data, input.include_series ?? false));
  const isWorkout = input.collection === "workout";
  if (isWorkout) await addWorkoutHeartRate(ctx, rows.map((r) => r.data), docs);
  return {
    collection: input.collection, window: { start, end }, count: rows.length,
    ...(rows.length === 40 ? { truncated: "Showing the newest 40 documents; narrow the window for more." } : {}),
    note: isWorkout ? `${COLLECTION_NOTE} Each workout also has a heart_rate block from the stored readings (time-weighted; minutes_by_zone uses the zones listed here).` : COLLECTION_NOTE,
    ...(isWorkout ? { zones: zoneLabels(zonesOf(ctx)) } : {}),
    documents: docs,
  };
}

// Today's morning check-in, so the Coach sees it in the call it already makes first.
async function todaysCheckin(ctx: ToolCtx) {
  const today = todayLocal(ctx);
  const [row] = await ctx.sql<{ rating: number; logged_at: Date; recalled: boolean; source: string }[]>`
    select rating, logged_at, recalled, source from morning_checkins where day = ${today}`;
  if (!row) return null;
  const rating = Number(row.rating);
  return { day: today, rating, label: ratingLabel(rating), logged_local: localDateTime(row.logged_at, ctx.timezone), recalled: row.recalled, source: row.source };
}
