import { heartRateGroups, localStamp, parseWindowEdge, type GroupBy } from "../hr/groups";
import { loadHeartRate, zonesOf, type HrPart } from "../hr/window";
import { heartRateStats, zoneLabels } from "../oura/hr";
import { ToolError, type ToolCtx } from "./context";

const DAY = 86_400_000;
export const MAX_DAYS = 92;
const HOUR_LIMIT_MS = 3 * DAY + 3_600_000; // 3 days (+1 h so a window over a clock change still fits)

export async function getHeartRate(ctx: ToolCtx, input: { start: string; end: string; group_by?: GroupBy; part?: HrPart }) {
  const tz = ctx.timezone, by = input.group_by ?? "none", part = input.part ?? "all";
  let s: number, e: number;
  try {
    s = parseWindowEdge(input.start, "start", tz);
    e = parseWindowEdge(input.end, "end", tz);
  } catch (err) { throw new ToolError((err as Error).message); }
  if (e <= s) throw new ToolError(`end (${input.end}) is not after start (${input.start}).`);
  if (e - s > MAX_DAYS * DAY + 3_600_000) throw new ToolError(`That window is longer than ${MAX_DAYS} days. Ask for a shorter one (or several), or use group_by "week" over a window of up to ${MAX_DAYS} days.`);
  if (by === "hour" && e - s > HOUR_LIMIT_MS) throw new ToolError(`group_by "hour" is only for windows of 3 days or less (at most 72 rows). Use group_by "day" for this window, or ask for hours one stretch at a time.`);

  const points = await loadHeartRate(ctx, new Date(s), new Date(e), part);
  const zones = zonesOf(ctx);
  const rows = heartRateGroups(s, e, by, tz).map((g) => {
    // [from, to): a reading exactly on a boundary belongs to the later group only
    const inGroup = points.filter((p) => p.t >= g.from && p.t < g.to);
    const st = heartRateStats(inGroup, g.from, g.to, zones);
    return { from: localStamp(g.from, tz), to: localStamp(g.to, tz), avg: st.avg, min: st.min, max: st.max, samples: st.samples, covered_minutes: st.covered_minutes, window_minutes: st.window_minutes, minutes_by_zone: st.minutes_by_zone };
  });
  const covered = rows.reduce((a, r) => a + r.covered_minutes, 0), total = rows.reduce((a, r) => a + r.window_minutes, 0);
  const notes = [
    "Readings are time-weighted: each one holds until the next, up to 5 minutes (a longer silence is a gap, not data). minutes_by_zone uses the zones above.",
    ...(part === "all" && total > 0 && covered < total * 0.6
      ? [`Only ${Math.round(covered)} of ${Math.round(total)} minutes in this window are backed by readings. The ring was off, charging, or not synced yet. A gap is NOT a low heart rate: do not read it as one.`]
      : []),
    ...(part !== "all" ? [`part "${part}" counts only ${part === "asleep" ? "overnight (sleep) readings" : "readings from outside sleep"}, so covered_minutes is naturally lower than the window.`] : []),
  ];
  return {
    window: { from: localStamp(s, tz), to: localStamp(e, tz), timezone: tz }, group_by: by, part, zones: zoneLabels(zones),
    rows, note: notes.join(" "),
  };
}
