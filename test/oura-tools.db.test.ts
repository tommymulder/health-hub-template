import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import type { OuraApi } from "@/core/oura/client";
import { upsertWorkout } from "@/core/hevy/sync";
import type { HevyWorkout } from "@/core/hevy/types";
import { ToolError, type ToolCtx } from "@/core/tools/context";
import { getOuraData, getRecovery, pickNight } from "@/core/tools/recovery";
import { getSyncStatus, syncNow } from "@/core/tools/sync";
import { getWorkoutDetails } from "@/core/tools/workouts";
import { addDays } from "@/core/time";

// Seeded far in the future (2031) so real data never interferes; every test is rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
const NOW = new Date("2031-03-12T20:00:00Z"); // local today = 2031-03-12 (PDT)
async function inTest(fn: (ctx: ToolCtx, tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => NOW }, tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

type Doc = Record<string, unknown>;
async function put(tx: Sql, collection: string, id: string, day: string | null, data: Doc, start: string | null = null, end: string | null = null) {
  await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values (${collection}, ${id}, ${day}, ${start}, ${end}, ${tx.json(data as never)})`;
}

// 40 ordinary days then one standout day (2031-03-12): the baseline needs 14+ days of history.
async function seedRecovery(tx: Sql) {
  for (let i = 0; i < 41; i++) {
    const day = addDays("2031-02-01", i);
    const last = day === "2031-03-12";
    await put(tx, "daily_readiness", `r-${day}`, day, { day, score: last ? 88 : 80, temperature_deviation: -0.2, contributors: { hrv_balance: 70 } });
    await put(tx, "daily_sleep", `ds-${day}`, day, { day, score: 75, contributors: { deep_sleep: 50 } });
    await put(tx, "daily_activity", `a-${day}`, day, { day, steps: last ? 12000 : 8000, active_calories: 400, score: 80 });
    await put(tx, "sleep", `s-${day}`, day, { day, type: "long_sleep", average_hrv: last ? 36 : 30, lowest_heart_rate: 60, total_sleep_duration: 28800, time_in_bed: 30000, efficiency: 90, deep_sleep_duration: 5400, rem_sleep_duration: 6000, light_sleep_duration: 17400 },
      `${day}T06:00:00Z`, `${day}T14:00:00Z`); // 06:00Z = 23:00 Pacific the evening BEFORE `day`; 14:00Z = 07:00 Pacific on `day`
  }
  await put(tx, "sleep", "nap", "2031-03-12", { day: "2031-03-12", type: "sleep", total_sleep_duration: 1800 }, "2031-03-12T21:00:00Z", "2031-03-12T21:30:00Z");
}

describe.skipIf(!sql)("Oura tools against Postgres (always rolled back)", () => {
  it("get_recovery: a day's numbers, each against the previous-60-day median baseline", async () => {
    await inTest(async (ctx, tx) => {
      await seedRecovery(tx);
      const r = await getRecovery(ctx, { days: 1 });
      const [d] = r.days as Record<string, any>[];
      expect(d.day).toBe("2031-03-12");
      expect(d.readiness).toMatchObject({ score: 88, vs_baseline_pct: 10, temperature_deviation_c: -0.2 }); // (88-80)/80
      expect(d.sleep).toMatchObject({
        score: 75, total_hours: 8, efficiency_pct: 90, deep_min: 90, rem_min: 100, light_min: 290,
        avg_hrv_ms: 36, hrv_vs_baseline_pct: 20, // (36-30)/30
        lowest_hr: 60, bedtime_local: "2031-03-11 23:00", wake_local: "2031-03-12 07:00", naps_min: 30, // the DATE matters: a bare "23:00" does not say which night
      });
      expect(d.sleep.hours_vs_baseline_pct).toBe(0);
      expect(d.activity).toMatchObject({ steps: 12000, steps_vs_baseline_pct: 50 }); // (12000-8000)/8000
      expect(r.window).toEqual({ start: "2031-03-12", end: "2031-03-12" });
    });
  });

  it("get_recovery: the baseline is a MEDIAN, so one terrible night in the previous 60 days does not move it", async () => {
    await inTest(async (ctx, tx) => {
      await seedRecovery(tx);
      await tx`update oura_documents set data = jsonb_set(data, '{average_hrv}', '1') where collection = 'sleep' and id = 's-2031-02-10'`;
      const [d] = (await getRecovery(ctx, { days: 1 })).days as Record<string, any>[];
      expect(d.sleep.hrv_vs_baseline_pct).toBe(20); // median still 30; a mean would have said about +23
    });
  });

  it("get_recovery: the first days have no baseline until 14 nights of history exist", async () => {
    await inTest(async (ctx, tx) => {
      await seedRecovery(tx);
      const r = await getRecovery(ctx, { days: 41 });
      const early = (r.days as Record<string, any>[]).find((d) => d.day === addDays("2031-02-01", 10))!; // only 10 prior nights
      expect(early.sleep.hrv_vs_baseline_pct).toBeUndefined();
      const later = (r.days as Record<string, any>[]).find((d) => d.day === addDays("2031-02-01", 20))!; // 20 prior nights
      expect(later.sleep.hrv_vs_baseline_pct).toBe(0);
    });
  });

  it("get_recovery: newest first, skips days with nothing recorded, and explains an empty hub", async () => {
    await inTest(async (ctx, tx) => {
      await seedRecovery(tx);
      await tx`delete from oura_documents where day = '2031-03-10'`; // ring off that day
      const r = await getRecovery(ctx, { days: 4 });
      expect((r.days as { day: string }[]).map((d) => d.day)).toEqual(["2031-03-12", "2031-03-11", "2031-03-09"]);
      await expect(getRecovery({ ...ctx, now: () => new Date("2040-01-01T20:00:00Z") }, { days: 3 })).rejects.toThrow(ToolError);
      await expect(getRecovery({ ...ctx, now: () => new Date("2040-01-01T20:00:00Z") }, { days: 3 })).rejects.toThrow(/connect_oura/);
    });
  });

  it("pickNight: the longest long_sleep is the night; everything else is a nap", () => {
    const row = (type: string, sec: number) => ({ collection: "sleep", day: "d", start_at: null, end_at: null, data: { type, total_sleep_duration: sec } });
    const { night, napMin } = pickNight([row("long_sleep", 3600), row("long_sleep", 25200), row("sleep", 900), row("late_nap", 600)]);
    expect(night?.data.total_sleep_duration).toBe(25200);
    expect(napMin).toBe(Math.round((3600 + 900 + 600) / 60));
    expect(pickNight([row("sleep", 900)]).night).toBeNull();
  });

  it("get_oura_data: summarises big series by default, returns them on request, caps and orders results", async () => {
    await inTest(async (ctx, tx) => {
      const big = { day: "2031-03-12", type: "long_sleep", hrv: { interval: 300, timestamp: "x", items: Array.from({ length: 96 }, (_, i) => i) }, movement_30_sec: "1".repeat(900), average_hrv: 30 };
      await put(tx, "sleep", "big", "2031-03-12", big);
      const slim = await getOuraData(ctx, { collection: "sleep", start: "2031-03-12", end: "2031-03-12" });
      const doc = slim.documents[0] as Record<string, any>;
      expect(doc.average_hrv).toBe(30);
      expect(doc.hrv.items).toMatch(/96 values omitted/);
      expect(doc.movement_30_sec).toMatch(/900 chars omitted/);
      const full = await getOuraData(ctx, { collection: "sleep", start: "2031-03-12", end: "2031-03-12", include_series: true });
      expect((full.documents[0] as Record<string, any>).hrv.items).toHaveLength(96);

      for (let i = 0; i < 45; i++) await put(tx, "daily_stress", `st${i}`, addDays("2031-01-20", i % 30), { day: "x", stress_high: i });
      const stress = await getOuraData(ctx, { collection: "daily_stress", start: "2031-01-01", end: "2031-03-12" });
      expect(stress.count).toBe(40);
      expect(stress.truncated).toMatch(/newest 40/);
    });
  });

  it("workout details: heart rate in the window, overlapping Oura workout, the night before, and that day's readiness", async () => {
    await inTest(async (ctx, tx) => {
      await seedRecovery(tx);
      // Workout 17:17-17:52 Pacific on 2031-03-12 = 00:17-00:52 UTC next day
      const w: HevyWorkout = { id: "test-oura-w", title: "Afternoon Workout", routine_id: null, description: null, start_time: "2031-03-13T00:17:43Z", end_time: "2031-03-13T00:52:43Z",
        updated_at: "2031-03-13T01:00:00Z", created_at: "2031-03-13T01:00:00Z", exercises: [] };
      await upsertWorkout(tx, w, "America/Los_Angeles");
      const base = Date.parse("2031-03-13T00:17:43Z");
      const hr = [[0, 90], [10, 130], [20, 150], [30, 120]].map(([m, bpm]) => ({ ts: new Date(base + (m as number) * 60_000), bpm: bpm as number }));
      for (const r of hr) await tx`insert into hr_samples (ts, bpm, source) values (${r.ts}, ${r.bpm}, 'oura:awake')`;
      await tx`insert into hr_samples (ts, bpm, source) values (${new Date(base - 60 * 60_000)}, 55, 'oura:rest')`; // an hour before: must be excluded
      await put(tx, "workout", "ow", "2031-03-12", { day: "2031-03-12", activity: "fitnessClass", intensity: "moderate", calories: 412.6, source: "workout_heart_rate" }, "2031-03-13T00:10:00Z", "2031-03-13T00:55:00Z");

      const r = await getWorkoutDetails(ctx, { workout_id: "test-oura-w" });
      const o = r.oura as Record<string, any>;
      expect(o.connected).toBe(true);
      expect(o.heart_rate).toMatchObject({ samples: 4, min: 90, max: 150, window_minutes: 35, zones: { z1: "92-110", z2: "111-128", z3: "129-147", z4: "148-165", z5: "166+" } });
      // 90 bpm=below_z1 (0-10: 5 min cap), 130=z3 (10-20: 5 min), 150=z4 (20-30: 5 min), 120=z2 (30-35: 5 min)
      expect(o.heart_rate.minutes_by_zone).toMatchObject({ below_z1: 5, z2: 5, z3: 5, z4: 5 });
      expect(o.heart_rate.covered_minutes).toBe(20);
      expect(o.oura_workout).toEqual({ activity: "fitnessClass", intensity: "moderate", calories: 413, source: "workout_heart_rate" });
      expect(o.night_before).toMatchObject({
        day: "2031-03-12", sleep_score: 75, total_hours: 8, avg_hrv_ms: 36, lowest_hr: 60,
        bedtime_local: "2031-03-11 23:00", wake_local: "2031-03-12 07:00",
        hrv_vs_baseline_pct: 20, lowest_hr_vs_baseline_pct: 0, // vs the median of the previous 60 nights (HRV 30 -> 36 is +20%)
      });
      expect(o.readiness_that_day).toMatchObject({ score: 88 });
    });
  });

  it("workout details: honest when there are no heart-rate samples, and when Oura isn't in the hub at all", async () => {
    await inTest(async (ctx, tx) => {
      const w: HevyWorkout = { id: "test-oura-w2", title: "x", routine_id: null, description: null, start_time: "2031-04-01T17:00:00Z", end_time: "2031-04-01T17:30:00Z",
        updated_at: "2031-04-01T18:00:00Z", created_at: "2031-04-01T18:00:00Z", exercises: [] };
      await upsertWorkout(tx, w, "America/Los_Angeles");
      await put(tx, "daily_readiness", "r1", "2031-03-12", { day: "2031-03-12", score: 80 }); // some Oura data exists
      const r = await getWorkoutDetails(ctx, { workout_id: "test-oura-w2" });
      expect((r.oura as any).heart_rate).toMatchObject({ samples: 0 });
      expect((r.oura as any).night_before).toBeNull();
      expect((r.oura as any).readiness_that_day).toBeNull();

      await tx`delete from oura_documents`; // now Oura has nothing at all
      const none = await getWorkoutDetails(ctx, { workout_id: "test-oura-w2" });
      expect(none.oura).toMatchObject({ connected: false });
    });
  });

  it("sync status: reports Oura connection, per-collection counts and any errors, without drowning in per-source rows", async () => {
    await inTest(async (ctx, tx) => {
      await tx`delete from oauth_tokens where provider = 'oura'`;
      await tx`delete from sync_state where source like 'oura:%'`;
      await tx`delete from oura_documents`; await tx`delete from hr_samples`;
      expect((await getSyncStatus(tx)).oura).toMatchObject({ connected: false, sources_total: 0 });

      await tx`insert into oauth_tokens (provider, access_token, refresh_token, expires_at) values ('oura','a','r', now() + interval '1 day')`;
      await tx`insert into sync_state (source, cursor, last_ok_at) values ('oura:daily_readiness','2031-03-09', now()), ('oura:sleep','2031-03-09', now())`;
      await tx`insert into sync_state (source, last_error) values ('oura:workout','Oura GET failed: 500'), ('oura:vO2_max','unavailable: Oura denied access to vO2_max (HTTP 401)')`;
      await put(tx, "daily_readiness", "r1", "2031-03-10", { day: "2031-03-10" });
      await tx`insert into hr_samples (ts, bpm, source) values (now(), 70, 'oura:awake')`;
      const s = await getSyncStatus(tx);
      expect(s.oura).toMatchObject({ connected: true, sources_ok: 3, sources_total: 4, all_sources_healthy: false, unavailable_for_this_account: ["vO2_max"] }); // unavailable counts as fine, a 500 does not
      expect(s.oura.errors).toEqual([{ source: "oura:workout", error: "Oura GET failed: 500" }]); // the unavailable one is NOT listed as an error
      expect(s.oura.documents.daily_readiness).toMatchObject({ count: 1, first_day: "2031-03-10" });
      expect(s.oura.heart_rate_samples.count).toBe(1);
      expect(s.sources.some((x) => x.source.startsWith("oura:"))).toBe(false);
    });
  });

  it("sync_now(oura) explains when Oura isn't set up or isn't connected, and doesn't touch Hevy", async () => {
    await inTest(async (ctx, tx) => {
      await tx`delete from oauth_tokens where provider = 'oura'`;
      const deps = { sql: tx, hevy: {} as never, timezone: "America/Los_Angeles" };
      expect((await syncNow(deps, null, "oura")).oura).toMatchObject({ skipped: expect.stringMatching(/isn't set up/) });
      const oura = { sql: tx, oura: {} as OuraApi, timezone: "America/Los_Angeles" };
      const out = await syncNow(deps, oura, "oura");
      expect(out.oura).toMatchObject({ skipped: expect.stringMatching(/connect_oura/) });
      expect(out.hevy).toBeUndefined();
    });
  });
});
