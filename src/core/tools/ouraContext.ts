import { heartRateForWindow } from "../hr/window";
import { addDays, localDateTime } from "../time";
import { BASELINE_DAYS, BASELINE_MIN_SAMPLES, pctVsBaseline } from "../oura/recovery";
import type { ToolCtx } from "./context";

type Doc = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

// Heart rate in the workout window, the overlapping Oura workout, the night before, and that day's
// readiness: the "how did I sleep and what was my heart doing" context for one workout.
export async function ouraContextFor(ctx: ToolCtx, w: { start_at: Date; end_at: Date; local_date: string }) {
  const [any] = await ctx.sql`select 1 as x from oura_documents limit 1`;
  if (!any) return { connected: false, note: "Oura data isn't in the hub yet. Ask for connect_oura, then sync_now." };


  const stats = await heartRateForWindow(ctx, w.start_at, w.end_at);

  const [ow] = await ctx.sql<{ data: Doc }[]>`
    select data from oura_documents where collection = 'workout' and start_at < ${w.end_at} and end_at > ${w.start_at}
    order by least(end_at, ${w.end_at}::timestamptz) - greatest(start_at, ${w.start_at}::timestamptz) desc limit 1`;

  const [night] = await ctx.sql<{ day: string; start_at: Date; end_at: Date; data: Doc }[]>`
    select day::text as day, start_at, end_at, data from oura_documents
    where collection = 'sleep' and data->>'type' = 'long_sleep' and end_at <= ${w.start_at} and end_at > ${w.start_at}::timestamptz - interval '30 hours'
    order by end_at desc limit 1`;
  const [nightScore] = night
    ? await ctx.sql<{ data: Doc }[]>`select data from oura_documents where collection = 'daily_sleep' and day = ${night.day}`
    : [undefined];
  const [ready] = await ctx.sql<{ data: Doc }[]>`select data from oura_documents where collection = 'daily_readiness' and day = ${w.local_date}`;

  // How that night compares with the MEDIAN of the previous 60 nights (needs 14+): the baseline rule (DESIGN D6), so "HRV 28" reads as "-9% vs your normal".
  const [base] = night
    ? await ctx.sql<{ n: string; hrv: string | null; lhr: string | null }[]>`
        select count(*) as n, percentile_cont(0.5) within group (order by (data->>'average_hrv')::numeric) as hrv,
               percentile_cont(0.5) within group (order by (data->>'lowest_heart_rate')::numeric) as lhr
        from oura_documents
        where collection = 'sleep' and data->>'type' = 'long_sleep' and day < ${night.day} and day >= ${addDays(night.day, -BASELINE_DAYS)}`
    : [undefined];
  const enough = base && Number(base.n) >= BASELINE_MIN_SAMPLES;

  const sec = (v: unknown) => (num(v) === null ? null : round1((v as number) / 3600));
  return {
    connected: true,
    heart_rate:
      stats.samples > 0
        ? {
            ...stats,
            note: "Oura records heart rate irregularly (typically every 1-2 minutes, more often when active), so this is a dense sample of the session, not a continuous trace. Minutes are only counted around each sample (max 5 minutes), so covered_minutes can be less than the window.",
          }
        : { samples: 0, note: "No Oura heart-rate samples fall inside this workout (ring not worn, not synced yet, or no readings were taken)." },
    oura_workout: ow
      ? compact({ activity: ow.data.activity, intensity: ow.data.intensity, calories: num(ow.data.calories) === null ? null : Math.round(ow.data.calories as number), source: ow.data.source })
      : null,
    night_before: night
      ? compact({
          day: night.day,
          sleep_score: num(nightScore?.data.score),
          total_hours: sec(night.data.total_sleep_duration),
          efficiency_pct: num(night.data.efficiency),
          avg_hrv_ms: num(night.data.average_hrv),
          lowest_hr: num(night.data.lowest_heart_rate),
          bedtime_local: localDateTime(night.start_at, ctx.timezone),
          wake_local: localDateTime(night.end_at, ctx.timezone),
          hrv_vs_baseline_pct: enough ? pctVsBaseline(num(night.data.average_hrv), Number(base!.hrv)) : null,
          lowest_hr_vs_baseline_pct: enough ? pctVsBaseline(num(night.data.lowest_heart_rate), Number(base!.lhr)) : null,
        })
      : null,
    readiness_that_day: ready
      ? compact({ score: num(ready.data.score), temperature_deviation_c: num(ready.data.temperature_deviation), contributors: ready.data.contributors })
      : null,
  };
}
