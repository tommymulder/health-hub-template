import { localDateTime } from "../time";
import type { ToolCtx } from "../tools/context";
import type { DayAnalysis, Press } from "./night";

// Loading presses and turning a day's analysis into what Claude reads. Counts, nights and matches are computed when
// read from the raw events, so a better night rule fixes every past night.

export async function loadPresses(ctx: ToolCtx, from: Date, to: Date): Promise<Press[]> {
  const rows = await ctx.sql<{ id: string; at: Date; approximate: boolean }[]>`
    select id::text, at, approximate from events where type = 'bathroom' and not hidden and at >= ${from} and at < ${to} order by at`;
  return rows.map((r) => ({ id: Number(r.id), at: new Date(r.at), approximate: r.approximate }));
}

// Tracking starts at the first press (hidden mis-presses don't start it).
export async function trackingStart(ctx: ToolCtx): Promise<Date | null> {
  const [r] = await ctx.sql<{ first: Date | null }[]>`select min(at) as first from events where type = 'bathroom' and not hidden`;
  return r?.first ? new Date(r.first) : null;
}

const times = (presses: Press[], tz: string) => presses.map((p) => ({ id: p.id, time: localDateTime(p.at, tz), approximate: p.approximate }));

export const RING_NOTE = "Ring wake-ups come from Oura's 5-minute sleep stages (a run of 'awake' between falling asleep and the final wake). Oura can miss very short wakings, so it is a floor. A press matches a wake-up when it is inside it or within 20 minutes after it ends. A press after the morning wake time is a day trip: the final morning void is not a night trip.";

export function nightView(a: DayAnalysis, tz: string) {
  const { night } = a;
  if (!night.tracked && !night.ring) return undefined;
  return {
    ...(night.tracked ? {
      bathroom_trips: {
        count: night.presses.length, times: times(night.presses, tz),
        window: { kind: night.window.kind, from: localDateTime(new Date(night.window.from), tz), to: localDateTime(new Date(night.window.to), tz) },
      },
    } : {}),
    ...(night.ring ? { ring: { wake_ups: night.ring.wakeUps.length, longest_unbroken_sleep_min: night.ring.longestUnbrokenSleepMin, awake_min_in_wakeups: night.ring.awakeMinInWakeUps } } : {}),
    ...(night.matched ? { matched: { presses_matched: night.matched.matchedPressIds.length, presses_without_wakeup: night.matched.unmatchedPressIds.length, wakeups_without_press: night.matched.wakeUpsWithoutPress } } : {}),
    ...(night.flag ? { flag: night.flag, flag_note: "Tracking has started and the ring saw wake-ups, but there is no press: ask once whether they forgot, and log a remembered trip with log_event after they confirms the time." } : {}),
  };
}

// A day with no presses is "not_tracked", never 0: nobody goes a whole waking day without a trip, so it means they didn't log.
export function daytimeView(a: DayAnalysis, tz: string, trackingStarted: boolean) {
  if (!trackingStarted) return undefined;
  const d = a.daytime;
  if (!d.tracked) return { not_tracked: true };
  return {
    trips: { count: d.count, times: times(d.presses, tz) },
    ...(d.minutesBetween ? { minutes_between: d.minutesBetween } : {}),
    ...(d.first ? { first: times([d.first], tz)[0] } : {}),
    ...(d.last ? { last: times([d.last], tz)[0] } : {}),
  };
}
