import { addDays, daysBetween, localDate, localTime } from "../time";
import { kgToLb, outWeight } from "../units";
import { WORKING_SET_TYPES } from "../metrics";
import { dexaBlock, loadDexaScans } from "../labs/dexaRead";
import { num, resolveWindow, ToolError, type ToolCtx } from "./context";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Metrics that ADD UP over a day (steps, calories, distance...). Everything else is a reading, so a
// day's number is the average (with min/max). Getting this wrong would sum heart rates or average steps.
export const CUMULATIVE = new Set([
  "step_count", "active_energy", "basal_energy_burned", "walking_running_distance", "flights_climbed",
  "apple_exercise_time", "apple_stand_time", "apple_stand_hour", "distance_cycling", "distance_swimming",
  "swimming_stroke_count", "time_in_daylight", "dietary_energy", "dietary_water", "dietary_protein",
  "dietary_carbohydrates", "dietary_fat_total", "mindful_minutes", "number_of_alcoholic_beverages",
]);

async function appleAsOf(ctx: ToolCtx) {
  const [r] = await ctx.sql<{ last_ok_at: Date | null }[]>`select last_ok_at from sync_state where source = 'apple_health'`;
  const at = r?.last_ok_at ?? null;
  const ageH = at ? (Date.now() - at.getTime()) / 3_600_000 : null;
  return {
    as_of_apple: at ? at.toISOString() : null,
    ...(at === null
      ? { apple_note: "No Apple Health delivery has arrived yet. Health Auto Export pushes data from the phone." }
      : ageH! > 48
        ? { apple_note: `The newest Apple Health delivery is ${Math.round(ageH! / 24)} days old: the phone only sends while unlocked and Health Auto Export is allowed to run. Recent weigh-ins may be missing.` }
        : {}),
  };
}

// ---- get_body_metrics --------------------------------------------------------------------------

export interface Reading { day: string; at: Date; kg: number; fat: number | null; lean: number | null; bmi: number | null }

// Least-squares slope in kg per day over (dayIndex, kg) points.
export function slopePerDay(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n, my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
  return sxx === 0 ? null : sxy / sxx;
}

// Loads the scale's readings: ONE source is the truth (the source with the most weigh-ins, or the one
// asked for). Others, like Hevy's own midnight entry, are reported but never mixed into the trend.
export async function loadScale(ctx: ToolCtx, from: string, end: string, sourceOverride?: string) {
  const tz = ctx.timezone;
  const rows = await ctx.sql<{ metric: string; start_at: Date; source: string; value: number }[]>`
    select metric, start_at, source, value from apple_samples
    where metric in ('weight_body_mass','body_fat_percentage','lean_body_mass','body_mass_index') and not hidden and value is not null
      and (start_at at time zone ${tz})::date between ${from} and ${end}
    order by start_at`;
  const weights = rows.filter((r) => r.metric === "weight_body_mass");
  const counts = new Map<string, number>();
  for (const w of weights) counts.set(w.source, (counts.get(w.source) ?? 0) + 1);
  if (weights.length === 0) return { counts, primary: null as string | null, days: [] as Reading[] };
  const primary = sourceOverride ?? [...counts].sort((a, b) => b[1] - a[1])[0][0];
  if (!counts.has(primary)) throw new ToolError(`No weigh-ins from "${primary}". Sources: ${[...counts.keys()].map((s) => s || "(none)").join(", ")}.`);

  // The day's weight = the LAST reading that day (several weigh-ins a day happen; "latest" is easy to explain).
  const byDay = new Map<string, Reading>();
  for (const w of weights.filter((x) => x.source === primary)) {
    const day = localDate(w.start_at, tz);
    const prev = byDay.get(day);
    if (!prev || w.start_at > prev.at) byDay.set(day, { day, at: w.start_at, kg: w.value, fat: null, lean: null, bmi: null });
  }
  // Body fat, lean mass and BMI come from the same scale, within 10 minutes of the weigh-in.
  for (const r of rows.filter((x) => x.metric !== "weight_body_mass" && x.source === primary)) {
    const rd = byDay.get(localDate(r.start_at, tz));
    if (!rd || Math.abs(r.start_at.getTime() - rd.at.getTime()) > 10 * 60_000) continue;
    if (r.metric === "body_fat_percentage") rd.fat = r.value;
    else if (r.metric === "lean_body_mass") rd.lean = r.value;
    else rd.bmi = r.value;
  }
  return { counts, primary, days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

export const avg7 = (days: Reading[], day: string): number => {
  const v = days.filter((d) => d.day <= day && d.day >= addDays(day, -6)).map((d) => d.kg);
  return v.reduce((a, b) => a + b, 0) / v.length;
};

export async function getBodyMetrics(ctx: ToolCtx, input: { days?: number; source?: string }) {
  const { start, end } = resolveWindow(ctx, { days: input.days }, 90);
  const from = addDays(start, -6); // so the 7-day average of the first days has its history
  const tz = ctx.timezone;
  const { counts, primary, days } = await loadScale(ctx, from, end, input.source);
  if (primary === null) {
    throw new ToolError("No weigh-ins are stored for that window. Make sure the scale writes to Apple Health and Health Auto Export has delivered (see get_sync_status).");
  }

  const inWindow = days.filter((d) => d.day >= start);
  const entries = inWindow.map((d) => ({
    date: d.day, time: localTime(d.at, tz), weight: outWeight(d.kg, ctx.units), avg_7d: outWeight(avg7(days, d.day), ctx.units),
    ...(d.fat !== null ? { body_fat_pct: round1(d.fat) } : {}),
    ...(d.lean !== null ? { lean_mass: outWeight(d.lean, ctx.units) } : {}),
    ...(d.bmi !== null ? { bmi: round1(d.bmi) } : {}),
  }));

  // Rate of change: a straight line through the last 28 days of weigh-ins, ignoring days without one.
  const recent = inWindow.filter((d) => d.day >= addDays(end, -27));
  const span = recent.length ? daysBetween(recent[0].day, recent[recent.length - 1].day) : 0;
  const slope = recent.length >= 5 && span >= 10 ? slopePerDay(recent.map((d) => ({ x: daysBetween(recent[0].day, d.day), y: d.kg }))) : null;

  // Training next to the weight, so "is the weight trend matching the training?" can be answered.
  const types = [...WORKING_SET_TYPES];
  const weekly = await ctx.sql<{ week: string; sessions: string; volume_kg: string | null }[]>`
    select week, count(distinct id) as sessions, sum(vol) as volume_kg from (
      select date_trunc('week', w.local_date)::date::text as week, w.id,
             sum(case when t.type = 'bodyweight_assisted' then 0 else s.weight_kg * s.reps end) as vol
      from workouts w
      left join workout_exercises e on e.workout_id = w.id
      left join exercise_templates t on t.id = e.exercise_template_id
      left join sets s on s.workout_exercise_id = e.id and s.set_type in ${ctx.sql(types)}
      where not w.deleted and w.local_date between ${start} and ${end}
      group by 1, 2) x group by week order by week`;

  // Weigh-ins from other apps that fall BEFORE the scale's first reading (the scale may be newer than your history).
  const [oldest] = await ctx.sql<{ first: Date | null }[]>`select min(start_at) as first from apple_samples where metric = 'weight_body_mass' and source = ${primary} and not hidden`;
  const older = !oldest?.first ? [] : await ctx.sql<{ source: string; n: string; first: string; last: string }[]>`
    select source, count(*) as n, min(start_at at time zone ${tz})::date::text as first, max(start_at at time zone ${tz})::date::text as last
    from apple_samples where metric = 'weight_body_mass' and not hidden and source <> ${primary} and start_at < ${oldest.first}
    group by source order by min(start_at)`;

  // DEXA scans (Phase 16): the latest, the change since the previous one, and how the scale compared on scan day.
  const scans = await loadDexaScans(ctx);
  const lastScan = scans.map((s) => s.date).sort().pop();
  const scaleAroundScan = lastScan ? (await loadScale(ctx, addDays(lastScan, -3), addDays(lastScan, 3))).days : [];

  const latest = inWindow[inWindow.length - 1];
  return {
    window: { start, end },
    summary: latest ? {
      latest: { date: latest.day, weight: outWeight(latest.kg, ctx.units), avg_7d: outWeight(avg7(days, latest.day), ctx.units) },
      first_in_window: { date: inWindow[0].day, weight: outWeight(inWindow[0].kg, ctx.units) },
      change_in_window: outWeight(latest.kg - inWindow[0].kg, ctx.units),
      rate_per_week: slope === null ? null : round2(ctx.units === "lb" ? kgToLb(slope * 7) : slope * 7),
      weigh_ins: inWindow.length,
    } : null,
    units: ctx.units,
    primary_source: primary || "(no source)",
    other_sources: [...counts].filter(([s]) => s !== primary).map(([s, n]) => ({ source: s || "(no source)", readings: n })),
    ...(older.length ? {
      older_weights_from_other_sources: older.map((o) => ({ source: o.source || "(no source)", readings: Number(o.n), first: o.first, last: o.last })),
      older_weights_note: "These are earlier weigh-ins from other apps, before the scale. Ask for them with `source` (and a long `days` window); they are not mixed into the trend.",
    } : {}),
    dexa: dexaBlock(scans, scaleAroundScan, ctx.units),
    weigh_ins: entries,
    training_by_week: weekly.map((w) => ({ week_of: w.week, sessions: Number(w.sessions), volume: outWeight(num(w.volume_kg) ?? 0, ctx.units) })),
    notes: [
      "Daily weight bounces with water and food: read avg_7d (the average of weigh-ins in the 7 days up to that date), not a single reading.",
      slope === null ? "rate_per_week needs at least 5 weigh-ins spread over 10+ days within the last 28 days." : "rate_per_week is a straight-line fit through the last 28 days of weigh-ins.",
      "Hevy-sourced and other-source entries are listed in other_sources and kept out of the trend (pass `source` to use one instead).",
      "dexa is the measured body composition (scans the user logged): fat versus muscle claims come from there, between scan dates, never from the scale. Full per-region history: get_lab_results with panel DEXA.",
    ],
    ...(await appleAsOf(ctx)),
  };
}

// ---- list_health_types -------------------------------------------------------------------------

export async function listHealthTypes(ctx: ToolCtx) {
  const rows = await ctx.sql<{ metric: string; source: string; n: string; first: Date; last: Date; unit: string | null; hidden: string }[]>`
    select metric, source, count(*) as n, min(start_at) as first, max(start_at) as last, max(unit) as unit,
           count(*) filter (where hidden) as hidden
    from apple_samples group by metric, source order by metric, source`;
  const types = new Map<string, { metric: string; unit: string | null; samples: number; first: string; last: string; sources: { source: string; samples: number }[] }>();
  for (const r of rows) {
    const t = types.get(r.metric) ?? { metric: r.metric, unit: r.unit, samples: 0, first: r.first.toISOString(), last: r.last.toISOString(), sources: [] };
    t.samples += Number(r.n);
    if (r.first.toISOString() < t.first) t.first = r.first.toISOString();
    if (r.last.toISOString() > t.last) t.last = r.last.toISOString();
    t.sources.push({ source: r.source || "(merged, no source)", samples: Number(r.n) });
    types.set(r.metric, t);
  }
  const [wk] = await ctx.sql<{ n: string; linked: string }[]>`select count(*) as n, count(linked_workout_id) as linked from apple_workouts`;
  return {
    metrics: [...types.values()].map((t) => ({ ...t, first: localDate(t.first, ctx.timezone), last: localDate(t.last, ctx.timezone) })),
    apple_workouts: { count: Number(wk.n), linked_to_hevy: Number(wk.linked) },
    notes: [
      "Oura's own copies are never stored (the Oura API is the source for those). Sources shown as '(merged, no source)' are cumulative totals Apple already combined across devices.",
      "Energy is stored in kcal, weight in kg (shown in the user's units), other values in the unit shown.",
    ],
    ...(await appleAsOf(ctx)),
  };
}

// ---- get_health_data ---------------------------------------------------------------------------

const CAP_ROWS = 200;

export async function getHealthData(ctx: ToolCtx, input: { metric: string; start?: string; end?: string; aggregate?: "none" | "day" | "week" }) {
  const { start, end } = resolveWindow(ctx, { start: input.start, end: input.end }, 14);
  const tz = ctx.timezone;
  const agg = input.aggregate ?? "day";
  const [known] = await ctx.sql<{ unit: string | null }[]>`select max(unit) as unit from apple_samples where metric = ${input.metric}`;
  if (!known || known.unit === undefined || (await ctx.sql`select 1 from apple_samples where metric = ${input.metric} limit 1`).length === 0) {
    const names = await ctx.sql<{ metric: string }[]>`select distinct metric from apple_samples order by 1`;
    throw new ToolError(`No Apple Health metric called "${input.metric}". Available: ${names.map((n) => n.metric).join(", ") || "(none yet)"}.`);
  }
  const kg = known.unit === "kg", toUnit = (v: number | null) => (v === null ? null : kg ? outWeight(v, ctx.units) : round2(v));
  const unit = kg ? ctx.units : known.unit;
  const sum = CUMULATIVE.has(input.metric);

  if (agg === "none") {
    const rows = await ctx.sql<{ start_at: Date; source: string; value: number | null; min: number | null; max: number | null; extra: unknown }[]>`
      select start_at, source, value, min, max, extra from apple_samples
      where metric = ${input.metric} and not hidden and (start_at at time zone ${tz})::date between ${start} and ${end}
      order by start_at desc limit ${CAP_ROWS + 1}`;
    return {
      metric: input.metric, unit, window: { start, end }, aggregate: "none", count: Math.min(rows.length, CAP_ROWS),
      ...(rows.length > CAP_ROWS ? { truncated: `Showing the newest ${CAP_ROWS}; narrow the window or use aggregate day/week.` } : {}),
      samples: rows.slice(0, CAP_ROWS).map((r) => ({
        start_at: r.start_at.toISOString(), local: `${localDate(r.start_at, tz)} ${localTime(r.start_at, tz)}`, source: r.source || "(none)",
        value: toUnit(r.value), ...(r.min !== null ? { min: toUnit(r.min), max: toUnit(r.max) } : {}), ...(r.extra ? { extra: r.extra } : {}),
      })),
      ...(await appleAsOf(ctx)),
    };
  }

  const rows = await ctx.sql<{ bucket: string; n: string; total: number | null; avg: number | null; lo: number | null; hi: number | null }[]>`
    select (case when ${agg === "week"} then date_trunc('week', start_at at time zone ${tz}) else date_trunc('day', start_at at time zone ${tz}) end)::date::text as bucket,
           count(*) as n, sum(value) as total, avg(value) as avg, min(coalesce(min, value)) as lo, max(coalesce(max, value)) as hi
    from apple_samples
    where metric = ${input.metric} and not hidden and (start_at at time zone ${tz})::date between ${start} and ${end}
    group by 1 order by 1`;
  return {
    metric: input.metric, unit, window: { start, end }, aggregate: agg, how: sum ? "sum of all samples in the period" : "average of the samples in the period (with min and max)",
    periods: rows.map((r) => ({
      [agg === "week" ? "week_of" : "date"]: r.bucket, samples: Number(r.n),
      ...(sum ? { total: toUnit(r.total) } : { avg: toUnit(r.avg), min: toUnit(r.lo), max: toUnit(r.hi) }),
    })),
    notes: [
      "If one metric arrives from several sources (shown by list_health_types), totals could double count: check sources before trusting a sum.",
      ...(agg === "week" ? ["Weeks start Monday; a partial week at either end is a partial total."] : []),
    ],
    ...(await appleAsOf(ctx)),
  };
}

// ---- exclude_apple_sample ----------------------------------------------------------------------

export async function excludeAppleSample(ctx: ToolCtx, input: { metric: string; start_at: string; source?: string; restore?: boolean }) {
  const at = new Date(input.start_at);
  if (Number.isNaN(at.getTime())) throw new ToolError("start_at must be a timestamp like 2026-10-10T16:57:54Z (copy it from get_health_data with aggregate 'none').");
  const hide = !input.restore;
  // Exact match on the stored second; a wrong guess changes nothing and says so.
  const res = await ctx.sql<{ source: string }[]>`
    update apple_samples set hidden = ${hide}
    where metric = ${input.metric} and start_at = ${at} and (${input.source === undefined} or source = ${input.source ?? ""})
    returning source`;
  if (res.length === 0) throw new ToolError("No sample matched that metric, time and source. Nothing was changed. List the samples with get_health_data (aggregate 'none') and copy start_at exactly.");
  return {
    metric: input.metric, start_at: at.toISOString(), sources: res.map((r) => r.source || "(none)"),
    result: hide ? "hidden: it no longer counts in any tool. Nothing was deleted; pass restore: true to bring it back." : "restored: it counts again.",
  };
}
