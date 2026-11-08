import { addDays, localDate, wallClockToInstant } from "../time";

// Pure logic for "which night, which day" (Phase 17). No database, no Next imports (DESIGN D9).
// Terms: D is a WAKE-UP date (the same `day` Oura and the check-ins use). "The night of D" is the sleep that ENDS on D.
const MIN = 60_000;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface SleepNight { day: string; start: Date; end: Date; phases: string | null }
export interface SleepDoc { day: string; start_at: Date | null; end_at: Date | null; data: Record<string, unknown> }

// One main night per wake-up date: the longest long_sleep. Everything else that day is a nap and is never used.
export function nightsFromDocs(docs: SleepDoc[]): Map<string, SleepNight> {
  const best = new Map<string, { secs: number; night: SleepNight }>();
  for (const d of docs) {
    if (d.data.type !== "long_sleep") continue;
    const start = d.start_at ?? (typeof d.data.bedtime_start === "string" ? new Date(d.data.bedtime_start) : null);
    const end = d.end_at ?? (typeof d.data.bedtime_end === "string" ? new Date(d.data.bedtime_end) : null);
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const secs = num(d.data.total_sleep_duration) ?? 0;
    const cur = best.get(d.day);
    if (!cur || secs > cur.secs) best.set(d.day, { secs, night: { day: d.day, start, end, phases: typeof d.data.sleep_phase_5_min === "string" ? d.data.sleep_phase_5_min : null } });
  }
  return new Map([...best].map(([day, v]) => [day, v.night]));
}

const localAt = (date: string, hhmm: string, tz: string) => wallClockToInstant(`${date}T${hhmm}:00Z`, tz).getTime();

export interface Window { from: number; to: number; kind: "ring" | "fallback" } // epoch ms, [from, to)

// Bedtime - 60 min (getting into bed) to the wake time. Without ring data: 20:00 the evening before to 08:00.
export function nightWindow(day: string, nights: Map<string, SleepNight>, tz: string): Window {
  const n = nights.get(day);
  if (n) return { from: n.start.getTime() - 60 * MIN, to: n.end.getTime(), kind: "ring" };
  return { from: localAt(addDays(day, -1), "20:00", tz), to: localAt(day, "08:00", tz), kind: "fallback" };
}

// From the wake time of D to the start of the next night's window.
export function dayWindow(day: string, nights: Map<string, SleepNight>, tz: string): { from: number; to: number } {
  return { from: nightWindow(day, nights, tz).to, to: nightWindow(addDays(day, 1), nights, tz).from };
}

export interface Segment { kind: "night" | "day"; day: string; from: number; to: number }

// A press at 02:00 belongs to that night; a press after the wake time is a DAY trip (the final morning void is not a
// night trip: that is the standard definition of night-time voiding).
export function segmentFor(atMs: number, nights: Map<string, SleepNight>, tz: string): Segment {
  const d0 = localDate(new Date(atMs), tz);
  for (const day of [addDays(d0, -1), d0, addDays(d0, 1)]) {
    const nw = nightWindow(day, nights, tz);
    if (atMs >= nw.from && atMs < nw.to) return { kind: "night", day, from: nw.from, to: nw.to };
    const dw = dayWindow(day, nights, tz);
    if (atMs >= dw.from && atMs < dw.to) return { kind: "day", day, from: dw.from, to: dw.to };
  }
  return { kind: "day", day: d0, from: atMs, to: atMs + 1 }; // unreachable in practice: the windows are contiguous
}

// ---- ring wake-ups, matching, and the per-day analysis ----

export interface Press { id: number; at: Date; approximate: boolean }
export interface WakeUp { start: number; end: number } // epoch ms, [start, end)
export interface Ring { wakeUps: WakeUp[]; longestUnbrokenSleepMin: number; awakeMinInWakeUps: number }

// `sleep_phase_5_min` is one digit per 5 minutes from bedtime_start (1 deep, 2 light, 3 REM, 4 awake). A WAKE-UP is a run
// of 4 between the first and the last sleeping epoch: falling asleep at the start and the final wake don't count.
// Oura can miss very short wakings, so this is a floor, not a count of every time they were awake.
export function ringWakeUps(n: SleepNight): Ring | null {
  if (!n.phases || !/^[1-4]+$/.test(n.phases)) return null;
  const p = n.phases;
  const first = p.search(/[123]/);
  const last = Math.max(p.lastIndexOf("1"), p.lastIndexOf("2"), p.lastIndexOf("3"));
  const wakeUps: WakeUp[] = [];
  let longest = 0, run = 0, awakeEpochs = 0;
  if (first >= 0) {
    for (let i = first; i <= last; i++) {
      if (p[i] === "4") {
        awakeEpochs++;
        if (run > longest) longest = run;
        run = 0;
        const prevAwake = i > first && p[i - 1] === "4";
        const start = n.start.getTime() + i * 5 * MIN;
        if (prevAwake) wakeUps[wakeUps.length - 1].end = start + 5 * MIN;
        else wakeUps.push({ start, end: start + 5 * MIN });
      } else run++;
    }
    if (run > longest) longest = run;
  }
  return { wakeUps, longestUnbrokenSleepMin: longest * 5, awakeMinInWakeUps: awakeEpochs * 5 };
}

export interface Matching { matchedPressIds: number[]; unmatchedPressIds: number[]; wakeUpsWithoutPress: number }

// A press matches a wake-up when it falls inside it or within 20 minutes after it ends (they press once they are back in bed).
export function matchPresses(presses: Press[], wakeUps: WakeUp[]): Matching {
  const sorted = [...presses].sort((a, b) => a.at.getTime() - b.at.getTime());
  const matched: number[] = [], unmatched: number[] = [];
  const hit = new Set<number>();
  for (const p of sorted) {
    const t = p.at.getTime();
    // the wake-up that contains the press, else the latest one that ended at most 20 minutes before it
    let idx = wakeUps.findIndex((w) => t >= w.start && t < w.end);
    if (idx < 0) for (let i = wakeUps.length - 1; i >= 0; i--) if (t >= wakeUps[i].end && t <= wakeUps[i].end + 20 * MIN) { idx = i; break; }
    if (idx >= 0) { matched.push(p.id); hit.add(idx); } else unmatched.push(p.id);
  }
  return { matchedPressIds: matched, unmatchedPressIds: unmatched, wakeUpsWithoutPress: wakeUps.length - hit.size };
}

export interface DayStats { count: number; first?: Press; last?: Press; minutesBetween?: { average: number; longest: number; shortest: number } }

export function dayStats(presses: Press[]): DayStats {
  const s = [...presses].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (s.length === 0) return { count: 0 };
  const out: DayStats = { count: s.length, first: s[0], last: s[s.length - 1] };
  if (s.length >= 2) {
    const gaps = s.slice(1).map((p, i) => (p.at.getTime() - s[i].at.getTime()) / MIN);
    out.minutesBetween = { average: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), longest: Math.round(Math.max(...gaps)), shortest: Math.round(Math.min(...gaps)) };
  }
  return out;
}

export interface DayAnalysis {
  day: string;
  night: { window: Window; tracked: boolean; presses: Press[]; ring: Ring | null; matched?: Matching; flag?: "no_presses_but_ring_wakeups" };
  daytime: DayStats & { tracked: boolean; presses: Press[] };
  wakeDayTotal: number | null;
}

// Everything the Coach needs about one wake-up date D: the night that ended on D, the day of D, and how they line up
// with the ring. TRACKING STARTS at the first press (`trackingStart`): from then on a night with no presses is a real 0
// (flagged when the ring saw wake-ups, so the Coach can ask once), and before it nothing is reported (no fake zeros).
// A DAY with no presses is never 0: nobody goes a whole waking day without a trip, so it means they didn't log.
export function analyseDay(input: { day: string; nights: Map<string, SleepNight>; presses: Press[]; trackingStart: Date | null; tz: string }): DayAnalysis {
  const { day, nights, tz } = input;
  const nw = nightWindow(day, nights, tz), dw = dayWindow(day, nights, tz);
  const within = (p: Press, from: number, to: number) => p.at.getTime() >= from && p.at.getTime() < to;
  const nightPresses = input.presses.filter((p) => within(p, nw.from, nw.to)).sort((a, b) => a.at.getTime() - b.at.getTime());
  const dayPresses = input.presses.filter((p) => within(p, dw.from, dw.to)).sort((a, b) => a.at.getTime() - b.at.getTime());
  const n = nights.get(day);
  const ring = n ? ringWakeUps(n) : null;
  const nightTracked = input.trackingStart !== null && input.trackingStart.getTime() < nw.to;
  const dayTracked = input.trackingStart !== null && dayPresses.length > 0;
  const stats = dayStats(dayPresses);
  return {
    day,
    night: {
      window: nw, tracked: nightTracked, presses: nightPresses, ring,
      ...(nightTracked && ring ? { matched: matchPresses(nightPresses, ring.wakeUps) } : {}),
      ...(nightTracked && ring && nightPresses.length === 0 && ring.wakeUps.length > 0 ? { flag: "no_presses_but_ring_wakeups" as const } : {}),
    },
    daytime: { ...stats, tracked: dayTracked, presses: dayPresses },
    wakeDayTotal: nightTracked && dayTracked ? nightPresses.length + dayPresses.length : null,
  };
}
