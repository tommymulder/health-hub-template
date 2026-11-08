import { describe, it, expect } from "vitest";
import { analyzeFeel, splitFeel, type RatedMorning } from "@/core/checkins/feel";
import {
  averageRanks, hoursAfterWaking, parseNote, parseRating, parseShortcutBody,
  onTime, quartile, sampleConfidence, savedMessage, spearman,
} from "@/core/checkins/validate";
import { localDate } from "@/core/time";
import { ToolError } from "@/core/tools/context";

const reject = (value: unknown) => expect(() => parseRating(value)).toThrow(ToolError);

describe("check-in validation", () => {
  it("rejects 0, 6, 3.5 and words", () => {
    for (const bad of [0, 6, 3.5, -1, 1.5, "0", "6", "3.5", "good", "awful", "5great", "15", "", null, true]) reject(bad);
  });

  it("accepts integers, digit strings, and a menu label that starts with the digit", () => {
    expect(parseRating(4)).toBe(4);
    expect(parseRating("1")).toBe(1);
    expect(parseRating("5 Great")).toBe(5);
    expect(parseRating(" 2 Rough ")).toBe(2);
  });

  it("trims a note and refuses one over 500 characters", () => {
    expect(parseNote("  slept cold  ")).toBe("slept cold");
    expect(parseNote("   ")).toBeNull();
    expect(parseNote(undefined)).toBeNull();
    expect(() => parseNote("x".repeat(501))).toThrow(/500/);
    expect(parseNote("x".repeat(500))).toHaveLength(500);
  });

  it("rejects a shortcut body that is not an object", () => {
    expect(() => parseShortcutBody([])).toThrow(ToolError);
    expect(() => parseShortcutBody("4")).toThrow(ToolError);
  });

  it("formats the saved line without a comma, on the real weekday", () => {
    // 2026-10-15 is a Thursday (the 18th is a Sunday).
    expect(savedMessage(4, "2026-10-15")).toBe("Saved 4/5 (Good) for Thu Oct 15");
    expect(savedMessage(1, "2026-10-14")).toBe("Saved 1/5 (Awful) for Wed Oct 14");
  });
});

describe("local date boundary (the check-in is dated by the hub timezone)", () => {
  it("11:30pm and 12:30am are different wake-up dates", () => {
    // PDT is UTC-7 until 2026-11-01. 06:30Z is 11:30pm Oct 14; 07:30Z is 12:30am Oct 15.
    expect(localDate(new Date("2026-10-15T06:30:00Z"), "America/Los_Angeles")).toBe("2026-10-14");
    expect(localDate(new Date("2026-10-15T07:30:00Z"), "America/Los_Angeles")).toBe("2026-10-15");
  });
});

describe("hours after waking", () => {
  const wake = new Date("2026-10-15T14:45:00Z"); // 7:45am Pacific
  it("is logged_at minus the wake time, and null when there is no wake time", () => {
    expect(hoursAfterWaking(new Date("2026-10-15T16:45:00Z"), wake)).toBe(2);
    expect(hoursAfterWaking(new Date("2026-10-15T15:15:00Z"), wake)).toBe(0.5);
    expect(hoursAfterWaking(new Date("2026-10-15T16:45:00Z"), null)).toBeNull();
  });
});

describe("Spearman with ties", () => {
  it("uses average ranks and matches the hand-computed example", () => {
    expect(averageRanks([1, 2, 2, 4])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([10, 20, 30, 40])).toEqual([1, 2, 3, 4]);
    // dx [-1.5, 0, 0, 1.5], dy [-1.5, -0.5, 0.5, 1.5]
    // sum dx*dy = 4.5, sum dx^2 = 4.5, sum dy^2 = 5, rho = 4.5 / sqrt(22.5)
    expect(spearman([1, 2, 2, 4], [10, 20, 30, 40])).toBeCloseTo(4.5 / Math.sqrt(22.5), 12);
  });

  it("needs three pairs, and a flat series has no correlation", () => {
    expect(spearman([1, 2], [3, 4])).toBeNull();
    expect(spearman([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});

describe("sample size labels", () => {
  it("is too early under 14, an early pattern from 14 to 29, and comparable at 30", () => {
    expect(sampleConfidence(0)).toBe("too early");
    expect(sampleConfidence(13)).toBe("too early");
    expect(sampleConfidence(14)).toBe("early pattern, not proven");
    expect(sampleConfidence(29)).toBe("early pattern, not proven");
    expect(sampleConfidence(30)).toBe("enough mornings to compare");
  });
});

const morning = (over: Partial<RatedMorning> & Pick<RatedMorning, "day" | "rating">): RatedMorning => ({
  hours_after_waking: 0.5,
  sleep_score: null, total_hours: null, deep_min: null, rem_min: null, efficiency_pct: null,
  latency_min: null, avg_hrv_ms: null, lowest_hr: null, temperature_deviation_c: null,
  readiness: null, previous_steps: null, previous_classes: null, previous_lifting: null,
  ...over,
});

describe("feel versus the ring", () => {
  it("ranks the hand-computed scores and still says too early at n=4", () => {
    const rows = [
      morning({ day: "2026-01-01", rating: 1, sleep_score: 10 }),
      morning({ day: "2026-01-02", rating: 2, sleep_score: 20 }),
      morning({ day: "2026-01-03", rating: 2, sleep_score: 30 }),
      morning({ day: "2026-01-04", rating: 4, sleep_score: 40 }),
    ];
    const felt = analyzeFeel(rows);
    expect(felt.confidence).toBe("too early");
    expect(felt.correlations[0]).toMatchObject({ metric: "sleep_score", spearman: Math.round((4.5 / Math.sqrt(22.5)) * 1000) / 1000 });
    expect(felt.good_mornings.n).toBe(1);
    expect(felt.rough_mornings.n).toBe(3);
  });

  it("flags a high score with a low rating, and a low score with a high rating, using his own quartiles", () => {
    // sorted scores 50,60,70,80,90 → p25 60, p75 80
    expect(quartile([50, 60, 70, 80, 90], 0.25)).toBe(60);
    expect(quartile([50, 60, 70, 80, 90], 0.75)).toBe(80);
    const rows = [50, 60, 70, 80, 90].map((score, i) => morning({
      day: `2026-02-0${i + 1}`,
      rating: 5 - i,
      sleep_score: score,
    }));
    const kinds = analyzeFeel(rows).mismatches.map((m) => `${m.day}:${m.kind}`).sort();
    expect(kinds).toEqual([
      "2026-02-01:low_score_high_rating",
      "2026-02-02:low_score_high_rating",
      "2026-02-04:high_score_low_rating",
      "2026-02-05:high_score_low_rating",
    ]);
  });

  it("keeps a rating from 3 hours after waking out of the within-2h slice", () => {
    const rows = [
      morning({ day: "2026-03-01", rating: 5, hours_after_waking: 0.5, sleep_score: 80 }),
      morning({ day: "2026-03-02", rating: 1, hours_after_waking: 3, sleep_score: 40 }),
    ];
    const split = splitFeel(rows, true);
    expect(split.all.n).toBe(2);
    expect(split.within_2h.n).toBe(1);
    expect(split.confidence).toBe("too early");
    expect(split.summary).toMatch(/within 2 hours/);
    expect(splitFeel(rows, false).confidence).toBe("too early");
    expect(splitFeel(rows, false).all.n).toBe(2);
  });

  it("counts a rating logged up to an hour before Oura's wake time as on time", () => {
    expect(onTime(-0.5)).toBe(true);
    expect(onTime(-1)).toBe(true);
    expect(onTime(-1.5)).toBe(false);
    expect(onTime(2)).toBe(true);
    expect(onTime(2.5)).toBe(false);
    expect(onTime(null)).toBe(false);
  });

  it("says so plainly when every rating is the same, or a group is empty", () => {
    const same = [1, 2, 3, 4].map((i) => morning({ day: `2026-05-0${i}`, rating: 4, sleep_score: 60 + i }));
    expect(analyzeFeel(same).messages.join(" ")).toMatch(/Every rating so far is 4/);
    expect(analyzeFeel(same).correlations).toEqual([]);
    const noRough = [3, 4, 5].map((r, i) => morning({ day: `2026-05-1${i}`, rating: r, sleep_score: 70 + i }));
    expect(analyzeFeel(noRough).messages).toEqual(["No rough mornings (1-2) yet, so there's nothing to compare the good ones with."]);
    const noGood = [1, 2, 3].map((r, i) => morning({ day: `2026-05-2${i}`, rating: r, sleep_score: 70 + i }));
    expect(analyzeFeel(noGood).messages).toEqual(["No good mornings (4-5) yet, so there's nothing to compare the rough ones with."]);
    expect(analyzeFeel([]).messages).toEqual([]);
  });

  it("names the early-pattern band at 14 mornings", () => {
    const rows = Array.from({ length: 14 }, (_, i) => morning({ day: `2026-04-${String(i + 1).padStart(2, "0")}`, rating: (i % 5) + 1 }));
    expect(analyzeFeel(rows).confidence).toBe("early pattern, not proven");
    expect(analyzeFeel(rows.slice(0, 13)).confidence).toBe("too early");
  });
});
