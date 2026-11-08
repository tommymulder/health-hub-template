// ONE reader for "what was my heart doing between these two instants". Heart rate is a timeline (hr_samples); workouts,
// sleeps, classes and check-ins are just windows into it, so every tool asks here instead of running its own query.
import { DEFAULT_HR_ZONES, heartRateStats, zoneLabels, type HrPoint, type HrStats } from "../oura/hr";
import type { ToolCtx } from "../tools/context";

export type HrPart = "all" | "awake" | "asleep";
export const NIGHT_SOURCE = "oura:sleep";

export const zonesOf = (ctx: ToolCtx) => ctx.hrZones ?? DEFAULT_HR_ZONES;

// Readings in [start, end] as one point per instant: two sources reporting the same timestamp become their average.
export async function loadHeartRate(ctx: ToolCtx, start: Date, end: Date, part: HrPart = "all"): Promise<HrPoint[]> {
  const rows = await ctx.sql<{ t: string; bpm: string }[]>`
    select (extract(epoch from ts) * 1000)::bigint::text as t, avg(bpm)::text as bpm from hr_samples
    where ts between ${start} and ${end}
      and (${part} = 'all' or (${part} = 'asleep' and source = ${NIGHT_SOURCE}) or (${part} = 'awake' and source <> ${NIGHT_SOURCE}))
    group by ts order by ts`;
  return rows.map((r) => ({ t: Number(r.t), bpm: Number(r.bpm) }));
}

export type WindowHeartRate = HrStats & { zones: ReturnType<typeof zoneLabels> };

export async function heartRateForWindow(ctx: ToolCtx, start: Date, end: Date, opts: { part?: HrPart } = {}): Promise<WindowHeartRate> {
  const points = await loadHeartRate(ctx, start, end, opts.part ?? "all");
  return { ...heartRateStats(points, start.getTime(), end.getTime(), zonesOf(ctx)), zones: zoneLabels(zonesOf(ctx)) };
}
