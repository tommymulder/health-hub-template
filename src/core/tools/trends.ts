import { addDays, localDate, weekStart } from "../time";
import { outWeight } from "../units";
import { WORKING_SET_TYPES } from "../metrics";
import { num, resolveWindow, ToolError, type ToolCtx } from "./context";
import { loadScale } from "./apple";
import { BASELINE_DAYS, median } from "../oura/recovery";
import { localMidnight } from "../hr/groups";
import { loadHeartRate, zonesOf } from "../hr/window";
import { heartRateStats } from "../oura/hr";
import { analyseDay, nightsFromDocs } from "../events/night";
import { loadCompletionClasses } from "../compare/classes";
import { moduleOn } from "../modules";
import { classCompletion } from "../compare/completion";
import { loadPresses, trackingStart } from "../events/read";
import { wallClockToInstant } from "../time";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (v: number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// Oura workout kinds that count as "cardio" here. Walks and housework are everyday movement, not training, and Oura's
// own strength-training detection is left out because Hevy already records every lifting session (counting both would double it).
const CARDIO = new Set(["cardiovascularExercise", "running", "cycling", "swimming", "hiking", "dance", "rowing", "elliptical", "stairClimbing", "hiit"]);

type Doc = Record<string, unknown>;

// For each metric: which direction is "better" for the goals this hub coaches (fitter, lower resting heart rate, more recovered).
// Weight and body fat have no fixed good direction (it depends on the goal), so they are reported without a verdict.
// The week-row fields that belong to an optional module (hidden while it is off).
const EVENT_FIELDS = ["trips_per_tracked_night", "nights_tracked", "ring_wakeups_per_night", "longest_unbroken_sleep_min", "day_trips_per_tracked_day", "minutes_between_day_trips"];
const CLASS_FIELDS = ["class_completion_avg", "classes_counted"];

const GOOD: Record<string, "up" | "down" | null> = {
  hrv_ms: "up", lowest_hr_bpm: "down", sleep_hours: "up", sleep_score: "up", readiness: "up", steps_per_day: "up", vascular_age: "down",
  weight: null, body_fat_pct: null, trips_per_tracked_night: "down", class_completion_avg: "up",
};

export interface Week {
  week_of: string; partial: boolean; nights: number;
  hrv_ms: number | null; lowest_hr_bpm: number | null; sleep_hours: number | null; sleep_score: number | null; readiness: number | null;
  steps_per_day: number | null; vascular_age: number | null; weight: number | null; body_fat_pct: number | null;
  classes: number; class_minutes: number; lifting_sessions: number; other_cardio_minutes: number;
  workout_minutes_by_zone?: Record<"z1" | "z2" | "z3" | "z4" | "z5", number>;
  // Bathroom trips and the ring's wake-ups (Phase 17). Averages are over TRACKED nights / days only.
  trips_per_tracked_night?: number | null; nights_tracked?: number; ring_wakeups_per_night?: number | null; longest_unbroken_sleep_min?: number | null;
  day_trips_per_tracked_day?: number | null; minutes_between_day_trips?: number | null;
  class_completion_avg?: number | null; classes_counted?: number; // average board completion of the week's classes (Phase 19)
}

// Minutes in each heart-rate zone inside ANY Oura workout window (walks included), per Monday-start week. Overlapping
// windows (two devices recording the same hour) are merged first so no minute counts twice; each merged window belongs
// to the week it starts in. This is training volume, not a recovery signal, so it never gets a better/worse verdict.
export function zoneMinutesByWeek(
  windows: { start: number; end: number }[], points: { t: number; bpm: number }[], zones: readonly number[], tz: string,
): Map<string, Record<"z1" | "z2" | "z3" | "z4" | "z5", number>> {
  const sorted = windows.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  const out = new Map<string, Record<"z1" | "z2" | "z3" | "z4" | "z5", number>>();
  for (const w of merged) {
    const wk = weekStart(localDate(new Date(w.start), tz));
    const st = heartRateStats(points, w.start, w.end, zones);
    const acc = out.get(wk) ?? { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    for (const z of ["z1", "z2", "z3", "z4", "z5"] as const) acc[z] = round1(acc[z] + st.minutes_by_zone[z]);
    out.set(wk, acc);
  }
  return out;
}

// How big a change has to be before it is worth a verdict. Week-to-week wobble is normal (HRV and resting heart rate
// especially), so smaller moves are reported as numbers with no "better"/"worse".
export const MEANINGFUL: Record<string, { pct?: number; abs?: number }> = {
  hrv_ms: { pct: 5 }, lowest_hr_bpm: { abs: 2 }, sleep_hours: { pct: 5 }, sleep_score: { pct: 3 }, readiness: { pct: 3 }, steps_per_day: { pct: 10 }, vascular_age: { abs: 1 },
  trips_per_tracked_night: { abs: 0.5 }, class_completion_avg: { abs: 5 },
};

// Compare the last 4 full weeks with the 4 before them (needs at least 3 weeks of data in each).
export function compare(weeks: Week[], key: keyof Week, goodDir: "up" | "down" | null) {
  const full = weeks.filter((w) => !w.partial && w[key] !== null && w.nights >= 3);
  if (full.length < 6) return null;
  const last = full.slice(-4), prev = full.slice(-8, -4);
  if (last.length < 3 || prev.length < 3) return null;
  const a = mean(last.map((w) => w[key] as number))!, b = mean(prev.map((w) => w[key] as number))!;
  const change = a - b, pct = b !== 0 ? (change / Math.abs(b)) * 100 : null;
  const direction = pct === null || Math.abs(pct) < 1 ? "flat" : change > 0 ? "up" : "down";
  const rule = MEANINGFUL[key as string];
  const meaningful = !rule ? null : rule.abs !== undefined ? Math.abs(change) >= rule.abs : pct !== null && Math.abs(pct) >= (rule.pct ?? 0);
  const verdict = direction === "flat" || goodDir === null || !meaningful ? undefined : direction === goodDir ? "better" : "worse";
  return {
    last_4_weeks: round1(a), previous_4_weeks: round1(b), change: round2(change), change_pct: pct === null ? null : round1(pct), direction,
    ...(meaningful === null ? {} : { meaningful }), ...(verdict ? { verdict } : {}),
  };
}

export async function getTrends(ctx: ToolCtx, input: { weeks?: number }) {
  const weeks = input.weeks ?? 12;
  const end = localDate(ctx.now?.() ?? new Date(), ctx.timezone);
  const firstMonday = addDays(weekStart(end), -(weeks - 1) * 7);
  resolveWindow(ctx, { start: firstMonday, end }, 90); // validates the span (capped at 366 days)
  const tz = ctx.timezone;

  // Load far enough back for the 60-night median (plus the 7 recent nights) even when only a few weeks are shown.
  const loadFrom = firstMonday < addDays(end, -(BASELINE_DAYS + 6)) ? firstMonday : addDays(end, -(BASELINE_DAYS + 6));
  const docs = await ctx.sql<{ collection: string; day: string; start_at: Date | null; end_at: Date | null; data: Doc }[]>`
    select collection, day::text as day, start_at, end_at, data from oura_documents
    where day between ${loadFrom} and ${end}
      and collection in ('sleep','daily_sleep','daily_readiness','daily_activity','daily_cardiovascular_age','workout')`;
  if (docs.length === 0) throw new ToolError("No Oura data is stored for that window yet. Ask for connect_oura, then sync_now.");

  // One main night per day: the longest long_sleep (everything else that day is a nap).
  const night = new Map<string, Doc>();
  for (const d of docs.filter((x) => x.collection === "sleep" && x.data.type === "long_sleep")) {
    const cur = night.get(d.day);
    if (!cur || (num(d.data.total_sleep_duration) ?? 0) > (num(cur.total_sleep_duration) ?? 0)) night.set(d.day, d.data);
  }
  const byDay = (c: string) => new Map(docs.filter((x) => x.collection === c).map((x) => [x.day, x.data]));
  const dailySleep = byDay("daily_sleep"), readiness = byDay("daily_readiness"), activity = byDay("daily_activity"), vascular = byDay("daily_cardiovascular_age");

  const scale = await loadScale(ctx, firstMonday, end);
  const weightByDay = new Map(scale.days.map((d) => [d.day, d]));

  const lifting = await ctx.sql<{ week: string; n: string }[]>`
    select date_trunc('week', local_date)::date::text as week, count(*) as n from workouts
    where not deleted and local_date between ${firstMonday} and ${end}
      and id not in (select hevy_workout_id from class_sessions where hevy_workout_id is not null) -- a class counts once, as a class
      and exists (select 1 from workout_exercises e join sets s on s.workout_exercise_id = e.id where e.workout_id = workouts.id and s.set_type in ${ctx.sql([...WORKING_SET_TYPES])})
    group by 1`;
  const liftByWeek = new Map(lifting.map((r) => [r.week, Number(r.n)]));

  const wkWindows = docs.filter((x) => x.collection === "workout").map((x) => ({ start: Date.parse(String(x.data.start_datetime)), end: Date.parse(String(x.data.end_datetime)) }));
  const hrPoints = wkWindows.length
    ? await loadHeartRate(ctx, new Date(localMidnight(firstMonday, tz)), new Date(localMidnight(addDays(end, 1), tz)))
    : [];
  const zoneMinutes = zoneMinutesByWeek(wkWindows, hrPoints, zonesOf(ctx), tz);

  // Bathroom trips: raw presses for the window, analysed per day (the night that ENDED that day, and that day).
  const dayStart = (d: string) => wallClockToInstant(`${d}T00:00:00Z`, tz);
  const eventsOn = moduleOn(ctx, "events"), classesOn = moduleOn(ctx, "classes");
  const presses = eventsOn ? await loadPresses(ctx, dayStart(addDays(firstMonday, -2)), dayStart(addDays(end, 2))) : [];
  const trackedFrom = eventsOn ? await trackingStart(ctx) : null;
  const sleepNights = nightsFromDocs(docs.filter((x) => x.collection === "sleep") as never);

  // Board completion per week (Phase 19): computed from the stored classes, never stored.
  const completionByWeek = new Map<string, number[]>();
  for (const c of classesOn ? await loadCompletionClasses(ctx.sql) : []) {
    const pct = classCompletion(c).pct;
    if (pct === null || c.date < firstMonday || c.date > end) continue;
    const wkOf = weekStart(c.date);
    completionByWeek.set(wkOf, [...(completionByWeek.get(wkOf) ?? []), pct]);
  }

  const out: Week[] = [];
  for (let wk = firstMonday; wk <= end; wk = addDays(wk, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(wk, i)).filter((d) => d <= end);
    const nights = days.map((d) => night.get(d)).filter((n): n is Doc => !!n);
    const vals = (f: (d: string) => number | null) => days.map(f).filter((v): v is number => v !== null);
    const hrv = nights.map((n) => num(n.average_hrv)).filter((v): v is number => v !== null);
    const lhr = nights.map((n) => num(n.lowest_heart_rate)).filter((v): v is number => v !== null);
    const sleepH = nights.map((n) => num(n.total_sleep_duration)).filter((v): v is number => v !== null).map((s) => s / 3600);
    const wts = days.map((d) => weightByDay.get(d)).filter((x) => !!x);
    const fats = wts.map((x) => x!.fat).filter((v): v is number => v !== null);
    const workouts = docs.filter((x) => x.collection === "workout" && days.includes(x.day));
    const mins = (d: Doc) => {
      const s = Date.parse(String(d.start_datetime)), e = Date.parse(String(d.end_datetime));
      return Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, (e - s) / 60000) : 0;
    };
    const classes = workouts.filter((x) => x.data.activity === "fitnessClass");
    const avgKg = mean(wts.map((x) => x!.kg));
    // A night counts as tracked when tracking had started AND the night is real (the ring recorded it, or there is a press):
    // a night with neither could be a ring that was off, and would only pull the average toward 0.
    const dayAnalyses = days.map((d) => analyseDay({ day: d, nights: sleepNights, presses, trackingStart: trackedFrom, tz }));
    const trackedNights = dayAnalyses.filter((a) => a.night.tracked && (a.night.ring !== null || a.night.presses.length > 0));
    const ringNights = dayAnalyses.filter((a) => a.night.ring !== null);
    const trackedDays = dayAnalyses.filter((a) => a.daytime.tracked);
    const betweenDays = dayAnalyses.filter((a) => a.daytime.minutesBetween);
    out.push({
      week_of: wk, partial: addDays(wk, 6) > end, nights: nights.length,
      hrv_ms: hrv.length ? round1(mean(hrv)!) : null,
      lowest_hr_bpm: lhr.length ? round1(mean(lhr)!) : null,
      sleep_hours: sleepH.length ? round1(mean(sleepH)!) : null,
      sleep_score: (() => { const v = vals((d) => num(dailySleep.get(d)?.score)); return v.length ? round1(mean(v)!) : null; })(),
      readiness: (() => { const v = vals((d) => num(readiness.get(d)?.score)); return v.length ? round1(mean(v)!) : null; })(),
      steps_per_day: (() => { const v = vals((d) => num(activity.get(d)?.steps)); return v.length ? Math.round(mean(v)!) : null; })(),
      vascular_age: (() => { const v = vals((d) => num(vascular.get(d)?.vascular_age)); return v.length ? round1(mean(v)!) : null; })(),
      weight: avgKg === null ? null : outWeight(avgKg, ctx.units),
      body_fat_pct: fats.length ? round1(mean(fats)!) : null,
      classes: classes.length, class_minutes: Math.round(classes.reduce((a, x) => a + mins(x.data), 0)),
      trips_per_tracked_night: trackedNights.length ? round1(mean(trackedNights.map((a) => a.night.presses.length))!) : null,
      nights_tracked: trackedNights.length,
      ring_wakeups_per_night: ringNights.length ? round1(mean(ringNights.map((a) => a.night.ring!.wakeUps.length))!) : null,
      longest_unbroken_sleep_min: ringNights.length ? round1(mean(ringNights.map((a) => a.night.ring!.longestUnbrokenSleepMin))!) : null,
      day_trips_per_tracked_day: trackedDays.length ? round1(mean(trackedDays.map((a) => a.daytime.count))!) : null,
      minutes_between_day_trips: betweenDays.length ? Math.round(mean(betweenDays.map((a) => a.daytime.minutesBetween!.average))!) : null,
      class_completion_avg: completionByWeek.has(wk) ? round1(mean(completionByWeek.get(wk)!)!) : null,
      classes_counted: completionByWeek.get(wk)?.length ?? 0,
      lifting_sessions: liftByWeek.get(wk) ?? 0,
      other_cardio_minutes: Math.round(workouts.filter((x) => CARDIO.has(String(x.data.activity))).reduce((a, x) => a + mins(x.data), 0)),
      workout_minutes_by_zone: zoneMinutes.get(wk) ?? { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    });
  }

  // Weight for the comparison is in the user's units already; compare in those units.
  const summary: Record<string, unknown> = {};
  for (const k of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
    const c = compare(out, k as keyof Week, GOOD[k]);
    if (c) summary[k] = c;
  }
  const full = out.filter((w) => !w.partial);

  // The baseline rule: compare with your own 60-night MEDIAN and act only when HRV and resting heart rate move TOGETHER.
  const recentDays = Array.from({ length: 7 }, (_, i) => addDays(end, -i));
  const baseDays = Array.from({ length: BASELINE_DAYS }, (_, i) => addDays(end, -(i + 7)));
  const pick = (days: string[], f: (n: Doc) => unknown) => days.map((d) => night.get(d)).filter((n): n is Doc => !!n).map(f).filter((v): v is number => num(v) !== null);
  const sig = (key: "average_hrv" | "lowest_heart_rate", rule: { pct?: number; abs?: number }, good: "up" | "down") => {
    const recent = pick(recentDays, (n) => n[key]), base = pick(baseDays, (n) => n[key]);
    if (recent.length < 4 || base.length < 21) return null;
    const r = mean(recent)!, m = median(base)!, change = r - m, pct = m !== 0 ? (change / m) * 100 : null;
    const meaningful = rule.abs !== undefined ? Math.abs(change) >= rule.abs : pct !== null && Math.abs(pct) >= (rule.pct ?? 0);
    const dir = change > 0 ? "up" : "down";
    return { last_7_nights_avg: round1(r), median_60_nights: round1(m), change: round2(change), change_pct: pct === null ? null : round1(pct), meaningful, ...(meaningful ? { verdict: dir === good ? "better" : "worse" } : {}) };
  };
  const hrvSig = sig("average_hrv", MEANINGFUL.hrv_ms, "up"), rhrSig = sig("lowest_heart_rate", MEANINGFUL.lowest_hr_bpm, "down");
  const verdicts = [hrvSig, rhrSig].map((s) => (s as { verdict?: string } | null)?.verdict);
  // Plain-language labels: 'steady' = neither moved beyond normal wobble; 'mixed' = only one moved, or they moved in
  // opposite directions. (This used to be one 'no_signal' label, which read like missing data.)
  const signal = verdicts[0] === "worse" && verdicts[1] === "worse" ? "both_worse"
    : verdicts[0] === "better" && verdicts[1] === "better" ? "both_better"
    : !verdicts[0] && !verdicts[1] ? "steady" : "mixed";
  const describe = (name: string, s: NonNullable<typeof hrvSig>, unit: "pct" | "bpm") => {
    const amount = unit === "pct" ? `${Math.abs(s.change_pct ?? 0)}%` : `${Math.abs(s.change)} bpm`;
    const signed = unit === "pct" ? `${(s.change_pct ?? 0) >= 0 ? "+" : "-"}${amount}` : `${s.change >= 0 ? "+" : "-"}${amount}`;
    const v = (s as { verdict?: string }).verdict;
    return v ? `${name} ${s.change > 0 ? "up" : "down"} ${amount} (${v})` : `${name} about the same (${signed}, normal wobble)`;
  };
  const recovery_signal = !hrvSig || !rhrSig
    ? { signal: "not_enough_data", summary: "Not enough nights yet to judge recovery.", note: "Needs at least 4 recent nights and 21 nights in the 60 before them." }
    : {
        hrv: hrvSig, lowest_hr: rhrSig,
        signal,
        summary: `${describe("HRV", hrvSig, "pct")}; ${describe("resting HR", rhrSig, "bpm")}, vs your 60-night median. ${
          signal === "both_worse" ? "Both point to under-recovery: back off."
          : signal === "both_better" ? "Both point to better recovery."
          : "Not moving together, so nothing to act on."}`,
        meaning: signal === "both_worse"
          ? "HRV is down and resting heart rate is up versus your own 60-night median: both point to under-recovery. That is the 'move together' signal to act on."
          : signal === "both_better"
            ? "HRV is up and resting heart rate is down versus your own 60-night median: both point to better recovery."
            : signal === "steady"
              ? "Steady: neither HRV nor resting heart rate moved beyond normal wobble versus your own 60-night median, so there is nothing to act on."
              : "Mixed: only one of HRV and resting heart rate moved meaningfully (or they moved in opposite directions). By your rule they must move together, so there is nothing to act on yet.",
      };

  // An optional module that is off leaves its fields (and the notes about them) out, rather than showing zeros.
  const hidden = new Set<string>([...(eventsOn ? [] : EVENT_FIELDS), ...(classesOn ? [] : CLASS_FIELDS)]);
  for (const k of hidden) delete summary[k];
  return {
    window: { first_week: firstMonday, last_week: weekStart(end), weeks: out.length },
    units: ctx.units,
    recovery_signal,
    summary_last_4_vs_previous_4_weeks: Object.keys(summary).length ? summary : "Not enough full weeks yet for a comparison (needs about 8 weeks of data).",
    weeks: out.map((w) => Object.fromEntries(Object.entries(w).filter(([k, v]) => v !== null && !hidden.has(k)))),
    averages_per_full_week: {
      classes: full.length ? round1(mean(full.map((w) => w.classes))!) : null,
      lifting_sessions: full.length ? round1(mean(full.map((w) => w.lifting_sessions))!) : null,
    },
    notes: [
      "Each row is one Monday-start week. hrv_ms is Oura's RMSSD averaged over the nights; lowest_hr_bpm is the lowest heart rate of each night (the usual resting-heart-rate proxy) averaged over the week. Higher HRV and a lower lowest HR generally mean better recovery or fitness, but weeks with fewer than 3 nights are noisy.",
      "classes are Oura-detected fitness classes (instructor-led); lifting_sessions are Hevy sessions with real working sets (a class's Hevy copy counts once, as a class); other_cardio_minutes are Oura runs, rides, swims, hikes and similar; walks and housework are not counted there, but walking time shows up in workout_minutes_by_zone.",
      "workout_minutes_by_zone: minutes in each heart-rate zone (Oura zones from HR_ZONES; z2 is the second zone, usually called Zone 2) inside ANY Oura workout, walks and lifts and classes included, each minute counted once even when two workouts overlap. Time-weighted from stored readings, so a stretch with no readings adds nothing. It is training volume, not a recovery signal: no better/worse verdict.",
      ...(eventsOn ? [
      "Bathroom trips (logged with the Action Button, day and night): trips_per_tracked_night and day_trips_per_tracked_day are averages over TRACKED nights and days only (a day with no presses is not_tracked, never 0; nights_tracked says how many nights counted). minutes_between_day_trips is the average gap between consecutive day trips. ring_wakeups_per_night and longest_unbroken_sleep_min come from Oura's 5-minute sleep stages (Oura can miss very short wakings). A better/worse verdict for trips per night appears only after enough tracked weeks (the same 8-week comparison as the other metrics) and only for a change of at least 0.5 trips a night.",
      ] : []),
      ...(classesOn ? [
      "class_completion_avg is the average board completion (the share of the posted work they did) of the week's classes that could be counted; classes_counted says how many. A class with nothing countable is left out, never scored 0. No better/worse verdict until enough weeks have classes (the same 8-week comparison as the other metrics), and only for a change of at least 5 points.",
      ] : []),
      "weight and body_fat_pct are the scale's weekly average (Apple Health); a week with no weigh-in omits them. Body fat from a home scale is noisy, so read its trend, never one week.",
      "The current week is marked partial and is left out of the comparison. A verdict (better/worse) is given only when the change is large enough to matter (otherwise `meaningful` is false: normal week-to-week wobble) and a direction is clearly good or bad; weight and body fat never get one because it depends on the goal.",
    ],
  };
}
