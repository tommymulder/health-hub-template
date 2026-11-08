import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { compare, getTrends, MEANINGFUL, type Week } from "@/core/tools/trends";
import type { ToolCtx } from "@/core/tools/context";

try { process.loadEnvFile(".env.local"); } catch { /* no local env file */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
// "Today" is Sunday 2026-10-11 (week of Mon 10-05 is full; weeks are Monday-start)
const ctxOf = (tx: Sql): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date("2026-10-11T20:00:00Z") });

const week = (over: Partial<Week>): Week => ({
  week_of: "x", partial: false, nights: 7, hrv_ms: 30, lowest_hr_bpm: 60, sleep_hours: 7, sleep_score: 75, readiness: 75, steps_per_day: 8000,
  vascular_age: 30, weight: null, body_fat_pct: null, classes: 0, class_minutes: 0, lifting_sessions: 0, other_cardio_minutes: 0, ...over,
});

describe("compare (last 4 weeks vs the 4 before)", () => {
  const eight = (a: number, b: number, key: keyof Week) => [...Array(4).fill(a), ...Array(4).fill(b)].map((v) => week({ [key]: v } as Partial<Week>));
  it("gives a verdict only for a meaningful move in a clearly good/bad direction", () => {
    expect(compare(eight(30, 36, "hrv_ms"), "hrv_ms", MEANINGFUL ? "up" : "up")).toMatchObject({ direction: "up", meaningful: true, verdict: "better", change_pct: 20 });
    expect(compare(eight(60, 64, "lowest_hr_bpm"), "lowest_hr_bpm", "down")).toMatchObject({ direction: "up", meaningful: true, verdict: "worse" });
    expect(compare(eight(60, 61, "lowest_hr_bpm"), "lowest_hr_bpm", "down")).toMatchObject({ direction: "up", meaningful: false });
    expect(compare(eight(60, 61, "lowest_hr_bpm"), "lowest_hr_bpm", "down")).not.toHaveProperty("verdict");
  });
  it("never gives weight a verdict (it depends on the goal) and calls tiny changes flat", () => {
    expect(compare(eight(200, 190, "weight"), "weight", null)).not.toHaveProperty("verdict");
    expect(compare(eight(30, 30.1, "hrv_ms"), "hrv_ms", "up")).toMatchObject({ direction: "flat" });
  });
  it("needs enough full weeks, and ignores partial weeks and thin weeks", () => {
    expect(compare(eight(30, 36, "hrv_ms").slice(0, 5), "hrv_ms", "up")).toBeNull();
    const withPartial = [...eight(30, 36, "hrv_ms"), week({ hrv_ms: 999, partial: true })];
    expect(compare(withPartial, "hrv_ms", "up")).toMatchObject({ last_4_weeks: 36 });
    const thin = eight(30, 36, "hrv_ms").map((w) => ({ ...w, nights: 1 }));
    expect(compare(thin, "hrv_ms", "up")).toBeNull();
  });
});

describe.skipIf(!sql)("get_trends (always rolled back)", () => {
  it("weekly rollups: main night only, class and cardio load, walks ignored, current week partial", async () => {
    await inRollback(async (tx) => {
      await tx`delete from oura_documents`; await tx`delete from class_sessions`; await tx`delete from workouts`; await tx`delete from apple_samples`; await tx`delete from hr_samples`;
      const doc = (collection: string, id: string, day: string, data: object, start?: string, end?: string) =>
        tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values (${collection}, ${id}, ${day}, ${start ?? null}, ${end ?? null}, ${tx.json(data as never)})`;
      // Week of Mon 2026-10-05: Mon-Tue nights (+ a nap on Tue that must be ignored)
      await doc("sleep", "n1", "2026-10-05", { type: "long_sleep", average_hrv: 30, lowest_heart_rate: 60, total_sleep_duration: 7 * 3600 });
      await doc("sleep", "n2", "2026-10-06", { type: "long_sleep", average_hrv: 40, lowest_heart_rate: 64, total_sleep_duration: 8 * 3600 });
      await doc("sleep", "nap", "2026-10-06", { type: "sleep", average_hrv: 99, lowest_heart_rate: 40, total_sleep_duration: 1800 });
      await doc("sleep", "short", "2026-10-06", { type: "long_sleep", average_hrv: 5, lowest_heart_rate: 99, total_sleep_duration: 3600 }); // a shorter long_sleep the same day loses
      await doc("daily_readiness", "r1", "2026-10-05", { score: 80 });
      await doc("daily_readiness", "r2", "2026-10-06", { score: 70 });
      await doc("daily_activity", "a1", "2026-10-05", { steps: 4000 });
      await doc("daily_activity", "a2", "2026-10-06", { steps: 8000 });
      const w = (id: string, day: string, activity: string, s: string, e: string) => doc("workout", id, day, { activity, start_datetime: s, end_datetime: e }, s, e);
      await w("c1", "2026-10-05", "fitnessClass", "2026-10-05T14:00:00Z", "2026-10-05T15:00:00Z");
      await w("c2", "2026-10-06", "fitnessClass", "2026-10-06T14:00:00Z", "2026-10-06T14:50:00Z");
      await w("k1", "2026-10-07", "cycling", "2026-10-07T14:00:00Z", "2026-10-07T14:30:00Z");
      await w("walk", "2026-10-07", "walking", "2026-10-07T16:00:00Z", "2026-10-07T17:00:00Z");
      await w("lift", "2026-10-08", "strengthTraining", "2026-10-08T16:00:00Z", "2026-10-08T17:00:00Z"); // Hevy owns lifting, not Oura
      // Previous week (Mon 09-28): one night
      await doc("sleep", "p1", "2026-09-29", { type: "long_sleep", average_hrv: 20, lowest_heart_rate: 70, total_sleep_duration: 6 * 3600 });
      // A weigh-in and a Hevy lifting session this week
      await tx`insert into apple_samples (metric, start_at, source, value, unit) values ('weight_body_mass', '2026-10-06T15:00:00Z', 'Scale App', 90, 'kg')`;
      await tx`insert into workouts (id, title, start_at, end_at, local_date, raw) values ('t-lift', 'L', '2026-10-09T17:00:00Z', '2026-10-09T18:00:00Z', '2026-10-09', '{}'::jsonb)`;
      await tx`insert into workout_exercises (workout_id, position, exercise_title) values ('t-lift', 0, 'Squat')`;
      await tx`insert into sets (workout_exercise_id, position, set_type, weight_kg, reps) select id, 0, 'normal', 100, 5 from workout_exercises where workout_id = 't-lift'`;

      const r: any = await getTrends(ctxOf(tx), { weeks: 4 });
      expect(r.window).toMatchObject({ first_week: "2026-09-14", last_week: "2026-10-05", weeks: 4 });
      const wk = r.weeks.find((x: any) => x.week_of === "2026-10-05");
      expect(wk).toMatchObject({ nights: 2, hrv_ms: 35, lowest_hr_bpm: 62, sleep_hours: 7.5, readiness: 75, steps_per_day: 6000, classes: 2, class_minutes: 110, lifting_sessions: 1, other_cardio_minutes: 30 });
      expect(wk.workout_minutes_by_zone).toEqual({ z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 }); // no heart-rate readings seeded: nothing counted, and a gap is not data
      expect(wk.weight).toBeCloseTo(198.4, 1); // 90 kg in lb
      expect(wk.partial).toBe(false); // Mon 10-05 .. Sun 10-11 is complete as of Sunday
      const prev = r.weeks.find((x: any) => x.week_of === "2026-09-28");
      expect(prev).toMatchObject({ nights: 1, hrv_ms: 20, classes: 0 });
      expect(r.summary_last_4_vs_previous_4_weeks).toMatch(/Not enough full weeks/);
    });
  });

  it("the current (unfinished) week is marked partial", async () => {
    await inRollback(async (tx) => {
      await tx`delete from oura_documents`;
      await tx`insert into oura_documents (collection, id, day, data) values ('sleep', 'x', '2026-10-08', ${tx.json({ type: "long_sleep", average_hrv: 30, total_sleep_duration: 25200 } as never)})`;
      const ctx = { ...ctxOf(tx), now: () => new Date("2026-10-09T20:00:00Z") }; // Friday
      const r: any = await getTrends(ctx, { weeks: 4 });
      expect(r.weeks[r.weeks.length - 1]).toMatchObject({ week_of: "2026-10-05", partial: true });
    });
  });

  it("says so when there is no Oura data", async () => {
    await inRollback(async (tx) => {
      await tx`delete from oura_documents`;
      await expect(getTrends(ctxOf(tx), { weeks: 4 })).rejects.toThrow(/No Oura data/);
    });
  });
});

describe.skipIf(!sql)("recovery_signal: act only when HRV and resting heart rate move together (always rolled back)", () => {
  // 70 nights ending Sunday 2026-10-11: the 63 before the last 7 are HRV 30 / lowest HR 60 (the 60-night median);
  // the last 7 nights take the values given.
  async function seed(tx: Sql, recent: { hrv: number; hr: number }, base = { hrv: 30, hr: 60 }, nightsBack = 70) {
    await tx`delete from oura_documents`;
    for (let i = 0; i < nightsBack; i++) {
      const day = new Date(Date.UTC(2026, 9, 11 - i)).toISOString().slice(0, 10);
      const v = i < 7 ? recent : base;
      await tx`insert into oura_documents (collection, id, day, data) values ('sleep', ${"n" + i}, ${day}, ${tx.json({ type: "long_sleep", average_hrv: v.hrv, lowest_heart_rate: v.hr, total_sleep_duration: 25200 } as never)})`;
    }
  }
  const signal = async (tx: Sql, weeks = 4) => ((await getTrends(ctxOf(tx), { weeks })) as any).recovery_signal;

  it("both worse (HRV down 20%, lowest HR up 4 bpm) is the signal to act on", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 24, hr: 64 });
      const s = await signal(tx);
      expect(s).toMatchObject({ signal: "both_worse", hrv: { last_7_nights_avg: 24, median_60_nights: 30, change_pct: -20, verdict: "worse" }, lowest_hr: { change: 4, verdict: "worse" } });
      expect(s.meaning).toMatch(/under-recovery/);
    });
  });
  it("both better is reported as better", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 36, hr: 57 });
      expect(await signal(tx)).toMatchObject({ signal: "both_better" });
    });
  });
  it("only one metric moving is 'mixed', not a signal to act on (your rule)", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 24, hr: 60 }); // HRV clearly down, resting HR unchanged
      const s = await signal(tx);
      expect(s).toMatchObject({ signal: "mixed", hrv: { verdict: "worse" }, lowest_hr: { meaningful: false } });
      expect(s.meaning).toMatch(/nothing to act on/);
      expect(s.summary).toBe("HRV down 20% (worse); resting HR about the same (+0 bpm, normal wobble), vs your 60-night median. Not moving together, so nothing to act on.");
    });
  });
  it("HRV up while resting HR is flat is 'mixed' (a real case seen on 2026-10-11)", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 33, hr: 60 }, { hrv: 30, hr: 60 }); // HRV +10%, resting HR unchanged
      const s = await signal(tx);
      expect(s.signal).toBe("mixed");
      expect(s.summary).toMatch(/^HRV up 10% \(better\); resting HR about the same/);
    });
  });
  it("normal wobble (HRV -3%, lowest HR +1 bpm) is 'steady' and carries no verdict", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 29.1, hr: 61 });
      const s = await signal(tx);
      expect(s.signal).toBe("steady");
      expect(s.meaning).toMatch(/nothing to act on/);
      expect(s.summary).toMatch(/^HRV about the same \(-3%, normal wobble\); resting HR about the same \(\+1 bpm, normal wobble\)/);
      expect(s.hrv).not.toHaveProperty("verdict");
      expect(s.lowest_hr).not.toHaveProperty("verdict");
    });
  });
  it("both worse carries a plain-language summary that says to back off", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 24, hr: 64 });
      expect((await signal(tx)).summary).toBe("HRV down 20% (worse); resting HR up 4 bpm (worse), vs your 60-night median. Both point to under-recovery: back off.");
    });
  });
  it("the median is not dragged by one terrible night in the baseline", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 30, hr: 60 });
      await tx`update oura_documents set data = jsonb_set(data, '{average_hrv}', '1') where id = 'n30'`;
      expect((await signal(tx)).hrv.median_60_nights).toBe(30);
    });
  });
  it("without enough history it says so instead of guessing", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 24, hr: 64 }, { hrv: 30, hr: 60 }, 20); // 7 recent + 13 older nights: under the 21 needed
      expect(await signal(tx)).toMatchObject({ signal: "not_enough_data" });
    });
  });
  it("even a short window (4 weeks) still reaches back far enough for the 60-night median", async () => {
    await inRollback(async (tx) => {
      await seed(tx, { hrv: 24, hr: 64 });
      expect((await signal(tx, 4)).signal).toBe("both_worse");
    });
  });
});


import { zoneMinutesByWeek } from "@/core/tools/trends";

describe("workout_minutes_by_zone", () => {
  const MIN = 60_000, T = Date.parse("2026-10-07T17:00:00Z"); // Wed 2026-10-07 10:00 Pacific
  const z = [92, 111, 129, 148, 166];
  const pts = (from: number, to: number, bpm: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ t: T + (from + i) * MIN, bpm }));
  it("two overlapping workouts count each minute once", () => {
    // walk 0-30, class 20-50: merged 0-50 = 50 minutes, all at 120 bpm (Zone 2)
    const m = zoneMinutesByWeek([{ start: T, end: T + 30 * MIN }, { start: T + 20 * MIN, end: T + 50 * MIN }], pts(0, 49, 120), z, "America/Los_Angeles");
    expect(m.get("2026-10-05")!.z2).toBeCloseTo(50, 0);
    expect(m.get("2026-10-05")!.z3).toBe(0);
  });
  it("separate workouts add up, in the week each started", () => {
    const m = zoneMinutesByWeek([{ start: T, end: T + 10 * MIN }, { start: T + 7 * 86_400_000, end: T + 7 * 86_400_000 + 10 * MIN }],
      [...pts(0, 9, 120), ...pts(0, 9, 150).map((p) => ({ ...p, t: p.t + 7 * 86_400_000 }))], z, "America/Los_Angeles");
    expect(m.get("2026-10-05")!.z2).toBeCloseTo(10, 0);
    expect(m.get("2026-10-12")!.z4).toBeCloseTo(10, 0);
  });
});
