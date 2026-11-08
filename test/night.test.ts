import { describe, it, expect } from "vitest";
import { analyseDay, dayStats, dayWindow, matchPresses, nightsFromDocs, nightWindow, ringWakeUps, segmentFor, type Press, type SleepNight } from "@/core/events/night";

const TZ = "America/Los_Angeles";
const H = 3_600_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// Synthetic nights only.
const night = (day: string, startIso: string, endIso: string, phases: string | null = null): SleepNight => ({ day, start: new Date(startIso), end: new Date(endIso), phases });
const nightsOf = (...n: SleepNight[]) => new Map(n.map((x) => [x.day, x]));

describe("nightsFromDocs: the main night is the longest long_sleep; a nap is never used", () => {
  const doc = (day: string, type: string, secs: number, start: string, end: string, phases = "4222") => ({ day, start_at: new Date(start), end_at: new Date(end), data: { type, total_sleep_duration: secs, sleep_phase_5_min: phases } });
  it("picks the long sleep over a nap and a shorter long sleep on the same day", () => {
    const m = nightsFromDocs([
      doc("2031-05-02", "sleep", 6000, "2031-05-02T20:00:00Z", "2031-05-02T21:40:00Z", "nap"),
      doc("2031-05-02", "long_sleep", 20000, "2031-05-02T06:00:00Z", "2031-05-02T13:30:00Z", "MAIN"),
      doc("2031-05-02", "long_sleep", 3000, "2031-05-02T15:00:00Z", "2031-05-02T16:00:00Z", "SHORT"),
    ]);
    expect(m.get("2031-05-02")).toMatchObject({ day: "2031-05-02", phases: "MAIN" });
    expect(nightsFromDocs([doc("2031-05-03", "sleep", 6000, "2031-05-03T20:00:00Z", "2031-05-03T21:40:00Z")]).size).toBe(0);
  });
});

describe("the night of day D: bedtime - 60 min to wake time; with no ring data 20:00 D-1 to 08:00 D", () => {
  const n = night("2031-05-02", "2031-05-02T06:40:00Z", "2031-05-02T14:10:00Z"); // 23:40 PDT -> 07:10 PDT
  it("ring window", () => {
    const w = nightWindow("2031-05-02", nightsOf(n), TZ);
    expect(w.kind).toBe("ring");
    expect(iso(w.from)).toBe("2031-05-02T05:40:00.000Z");
    expect(iso(w.to)).toBe("2031-05-02T14:10:00.000Z");
  });
  it("fallback window, marked as such", () => {
    const w = nightWindow("2031-05-02", nightsOf(), TZ);
    expect(w.kind).toBe("fallback");
    expect(iso(w.from)).toBe("2031-05-02T03:00:00.000Z"); // 20:00 PDT on May 1
    expect(iso(w.to)).toBe("2031-05-02T15:00:00.000Z"); // 08:00 PDT on May 2
  });
  it("the DST fall-back night (2026-11-01) is 13 real hours in the fallback window", () => {
    const w = nightWindow("2026-11-01", nightsOf(), TZ); // 20:00 PDT Oct 31 -> 08:00 PST Nov 1
    expect(iso(w.from)).toBe("2026-11-01T03:00:00.000Z");
    expect(iso(w.to)).toBe("2026-11-01T16:00:00.000Z");
    expect((w.to - w.from) / H).toBe(13);
  });
  it("the day of D runs from the wake time to the next night's start (ring or fallback)", () => {
    const next = night("2031-05-03", "2031-05-03T07:30:00Z", "2031-05-03T15:00:00Z");
    expect(iso(dayWindow("2031-05-02", nightsOf(n, next), TZ).from)).toBe("2031-05-02T14:10:00.000Z");
    expect(iso(dayWindow("2031-05-02", nightsOf(n, next), TZ).to)).toBe("2031-05-03T06:30:00.000Z");
    expect(iso(dayWindow("2031-05-02", nightsOf(n), TZ).to)).toBe("2031-05-03T03:00:00.000Z"); // next night not known: 20:00 PDT
  });
});

describe("segmentFor: which night, or which day, a press belongs to", () => {
  const n = night("2031-05-02", "2031-05-02T06:40:00Z", "2031-05-02T14:10:00Z");
  const nights = nightsOf(n);
  const at = (s: string) => Date.parse(s);
  it("02:00 belongs to that night (wake-up date D)", () => {
    expect(segmentFor(at("2031-05-02T09:00:00Z"), nights, TZ)).toMatchObject({ kind: "night", day: "2031-05-02" });
  });
  it("an hour before bedtime already counts (getting into bed)", () => {
    expect(segmentFor(at("2031-05-02T05:45:00Z"), nights, TZ)).toMatchObject({ kind: "night", day: "2031-05-02" });
    expect(segmentFor(at("2031-05-02T05:30:00Z"), nights, TZ)).toMatchObject({ kind: "day", day: "2031-05-01" });
  });
  it("a press after the wake time (up for the day) is a DAY trip of D: the final morning void is not a night trip", () => {
    expect(segmentFor(at("2031-05-02T14:11:00Z"), nights, TZ)).toMatchObject({ kind: "day", day: "2031-05-02" });
  });
  it("late evening with tonight's sleep not stored yet uses the fallback night of the NEXT date", () => {
    expect(segmentFor(at("2031-05-03T06:30:00Z"), nights, TZ)).toMatchObject({ kind: "night", day: "2031-05-03" }); // 23:30 PDT May 2
  });
});

// ---- Part C ----
// Epochs (5 min each) from bedtime 2031-05-02T06:40:00Z. 4 = awake.
//  idx: 0-1 "44" falling asleep (not a wake-up) | 2-5 "2222" | 6-7 "44" wake-up #1 (+30..+40 min) | 8-12 "22222" |
//       13 "4" wake-up #2 (+65..+70 min) | 14-16 "222" | 17-19 "444" the final wake (not a wake-up)
const PHASES = "44" + "2222" + "44" + "22222" + "4" + "222" + "444";
const BED = "2031-05-02T06:40:00Z";
const bedMs = Date.parse(BED);
const ringNight = night("2031-05-02", BED, "2031-05-02T08:15:00Z", PHASES); // 20 epochs = 100 min in bed
const press = (id: number, minutesAfterBed: number, approximate = false): Press => ({ id, at: new Date(bedMs + minutesAfterBed * MIN), approximate });

describe("ringWakeUps: runs of 'awake' between the first and last sleeping epoch", () => {
  it("excludes falling asleep and the final wake; counts separate runs separately", () => {
    const r = ringWakeUps(ringNight)!;
    expect(r.wakeUps).toHaveLength(2);
    expect(r.wakeUps[0]).toEqual({ start: bedMs + 30 * MIN, end: bedMs + 40 * MIN });
    expect(r.wakeUps[1]).toEqual({ start: bedMs + 65 * MIN, end: bedMs + 70 * MIN });
    expect(r.awakeMinInWakeUps).toBe(15);
    expect(r.longestUnbrokenSleepMin).toBe(25); // the 5 epochs between the two wake-ups
  });
  it("a night with no awake runs has none; a night with no phases has no ring data; an all-awake string has none", () => {
    expect(ringWakeUps(night("2031-05-02", BED, "2031-05-02T08:15:00Z", "2222222"))).toMatchObject({ wakeUps: [], longestUnbrokenSleepMin: 35 });
    expect(ringWakeUps(night("2031-05-02", BED, "2031-05-02T08:15:00Z", null))).toBeNull();
    expect(ringWakeUps(night("2031-05-02", BED, "2031-05-02T08:15:00Z", "4444"))).toMatchObject({ wakeUps: [] });
  });
});

describe("matchPresses: inside a wake-up, or within 20 minutes after it ends", () => {
  const w = ringWakeUps(ringNight)!.wakeUps;
  it("matches inside, matches 20 minutes after, does not match 21 minutes after or before", () => {
    const m = matchPresses([press(1, 35), press(2, 60), press(3, 91), press(4, 20)], w);
    // 35 is inside #1; 60 is 20 min after #1's end (40): matched; 91 is 21 min after #2's end (70): not matched; 20 is before #1
    expect(m.matchedPressIds).toEqual([1, 2]);
    expect(m.unmatchedPressIds).toEqual([4, 3]);
    expect(m.wakeUpsWithoutPress).toBe(1); // #2 has no press (91 is too late)
  });
  it("one press per wake-up is enough; a press belongs to the wake-up that contains it", () => {
    const m = matchPresses([press(1, 35), press(2, 67)], w);
    expect(m.matchedPressIds).toEqual([1, 2]);
    expect(m.wakeUpsWithoutPress).toBe(0);
  });
});

describe("dayStats: minutes between consecutive trips", () => {
  const at = (hhmm: string, id: number): Press => ({ id, at: new Date(`2031-05-02T${hhmm}:00Z`), approximate: false });
  it("average, longest, shortest; first and last", () => {
    const d = dayStats([at("17:00", 1), at("19:00", 2), at("22:30", 3)]);
    expect(d).toMatchObject({ count: 3, minutesBetween: { average: 165, longest: 210, shortest: 120 } });
    expect(d.first!.id).toBe(1);
    expect(d.last!.id).toBe(3);
  });
  it("one trip gives no interval; no trips gives count 0", () => {
    expect(dayStats([at("17:00", 1)]).minutesBetween).toBeUndefined();
    expect(dayStats([])).toMatchObject({ count: 0 });
  });
});

describe("analyseDay: zero vs not tracked", () => {
  const nights = new Map([[ringNight.day, ringNight], ["2031-05-03", night("2031-05-03", "2031-05-03T06:40:00Z", "2031-05-03T14:10:00Z", "2222")]]);
  const first = new Date(bedMs + 35 * MIN);
  it("before the first press nothing is reported (no fake zeros)", () => {
    const a = analyseDay({ day: "2031-05-02", nights, presses: [], trackingStart: null, tz: TZ });
    expect(a.night.tracked).toBe(false);
    expect(a.daytime.tracked).toBe(false);
    expect(a.night.ring).not.toBeNull(); // the ring's wake-ups still show
    expect(a.wakeDayTotal).toBeNull();
  });
  it("a night that ended before tracking started is not tracked; the night the first press happened in is", () => {
    const later = new Date("2031-05-04T20:00:00Z");
    expect(analyseDay({ day: "2031-05-02", nights, presses: [], trackingStart: later, tz: TZ }).night.tracked).toBe(false);
    expect(analyseDay({ day: "2031-05-02", nights, presses: [press(1, 35)], trackingStart: first, tz: TZ }).night.tracked).toBe(true);
  });
  it("a tracked night with no presses is 0, and is flagged when the ring saw wake-ups", () => {
    const a = analyseDay({ day: "2031-05-02", nights, presses: [], trackingStart: new Date(bedMs - 86_400_000), tz: TZ });
    expect(a.night).toMatchObject({ tracked: true, flag: "no_presses_but_ring_wakeups" });
    expect(a.night.presses).toHaveLength(0);
    const quiet = analyseDay({ day: "2031-05-03", nights, presses: [], trackingStart: new Date(bedMs - 86_400_000), tz: TZ }); // phases "2222": no wake-ups
    expect(quiet.night).toMatchObject({ tracked: true });
    expect(quiet.night.flag).toBeUndefined();
  });
  it("a day with no presses is not_tracked (never 0) and has no wake-day total", () => {
    const a = analyseDay({ day: "2031-05-02", nights, presses: [press(1, 35)], trackingStart: first, tz: TZ });
    expect(a.daytime.tracked).toBe(false);
    expect(a.wakeDayTotal).toBeNull();
  });
  it("presses are split: night presses in the night window, later ones in the day; wake-day total = night + day", () => {
    const day1: Press = { id: 9, at: new Date("2031-05-02T20:00:00Z"), approximate: false }; // 13:00 PDT, well after the 08:15Z wake time
    const a = analyseDay({ day: "2031-05-02", nights, presses: [press(1, 35), press(2, 67), day1], trackingStart: first, tz: TZ });
    expect(a.night.presses.map((p) => p.id)).toEqual([1, 2]);
    expect(a.night.matched).toMatchObject({ matchedPressIds: [1, 2], wakeUpsWithoutPress: 0 });
    expect(a.daytime.presses.map((p) => p.id)).toEqual([9]);
    expect(a.wakeDayTotal).toBe(3);
  });
});
