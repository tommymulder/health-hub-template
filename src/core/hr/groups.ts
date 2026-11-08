// Time arithmetic for get_heart_rate: parsing window edges and cutting a window into groups at LOCAL boundaries
// (midnight, Monday, the hour), so a day can be 23 or 25 hours long and a reading never counts across a boundary.
import { addDays, localDate, localTime, weekStart, wallClockToInstant } from "../time";

export type GroupBy = "none" | "hour" | "day" | "week";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export const localMidnight = (date: string, tz: string): number => wallClockToInstant(`${date}T00:00:00Z`, tz).getTime();

// "2026-10-17" or "2026-10-17T22:00" (the hub's timezone unless it carries Z or an offset). A date-only END is the end of that day.
export function parseWindowEdge(input: string, edge: "start" | "end", tz: string): number {
  const v = input.trim();
  if (DATE.test(v)) {
    const ms = localMidnight(edge === "end" ? addDays(v, 1) : v, tz);
    if (Number.isNaN(ms)) throw new Error(`"${input}" is not a valid date.`);
    return ms;
  }
  const m = DATETIME.exec(v);
  if (!m) throw new Error(`"${input}" is not a date (YYYY-MM-DD) or a date-time (YYYY-MM-DDTHH:MM).`);
  const ms = m[5] ? Date.parse(v.replace(" ", "T")) : wallClockToInstant(`${m[1]}T${m[2]}${m[3] ?? ":00"}Z`, tz).getTime();
  if (Number.isNaN(ms)) throw new Error(`"${input}" is not a valid date-time.`);
  return ms;
}

export interface Group { from: number; to: number }

export function heartRateGroups(startMs: number, endMs: number, by: GroupBy, tz: string): Group[] {
  if (by === "none") return [{ from: startMs, to: endMs }];
  const cuts: number[] = [];
  if (by === "hour") {
    // local hours are whole hours of real time in every zone we use; cut on UTC hour marks after the window start
    for (let t = Math.floor(startMs / 3_600_000) * 3_600_000 + 3_600_000; t < endMs; t += 3_600_000) cuts.push(t);
  } else {
    let d = localDate(new Date(startMs), tz);
    d = by === "week" ? weekStart(d) : d;
    for (d = addDays(d, by === "week" ? 7 : 1); localMidnight(d, tz) < endMs; d = addDays(d, by === "week" ? 7 : 1)) cuts.push(localMidnight(d, tz));
  }
  const edges = [startMs, ...cuts.filter((c) => c > startMs), endMs];
  return edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1] }));
}

export const localStamp = (ms: number, tz: string) => `${localDate(new Date(ms), tz)} ${localTime(new Date(ms), tz)}`;
