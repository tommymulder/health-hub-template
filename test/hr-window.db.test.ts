import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { heartRateForWindow, loadHeartRate } from "@/core/hr/window";
import type { ToolCtx } from "@/core/tools/context";
import { getOuraData } from "@/core/tools/recovery";

// Seeded in 2031 so real data never interferes; every test is rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (ctx: ToolCtx, tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date("2031-03-12T20:00:00Z") }, tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const MIN = 60_000;
const T0 = Date.parse("2031-03-12T10:00:00Z");
const put = (tx: Sql, minute: number, bpm: number, source: string) => tx`insert into hr_samples (ts, bpm, source) values (${new Date(T0 + minute * MIN)}, ${bpm}, ${source})`;

describe.skipIf(!sql)("heartRateForWindow / loadHeartRate (always rolled back)", () => {
  it("collapses two sources at the same instant to their average, and reports the zone labels", async () => {
    await inTest(async (ctx, tx) => {
      await put(tx, 0, 100, "oura:awake"); await put(tx, 0, 120, "oura:workout"); await put(tx, 2, 130, "oura:awake");
      const pts = await loadHeartRate(ctx, new Date(T0), new Date(T0 + 5 * MIN));
      expect(pts).toEqual([{ t: T0, bpm: 110 }, { t: T0 + 2 * MIN, bpm: 130 }]);
      const hr = await heartRateForWindow(ctx, new Date(T0), new Date(T0 + 5 * MIN));
      expect(hr).toMatchObject({ samples: 2, zones: { z2: "111-128", z5: "166+" } });
    });
  });

  it("part filters by source: asleep = oura:sleep only, awake = everything else, all = both", async () => {
    await inTest(async (ctx, tx) => {
      await put(tx, 0, 55, "oura:sleep"); await put(tx, 5, 57, "oura:sleep"); await put(tx, 10, 90, "oura:awake"); await put(tx, 11, 95, "oura:rest");
      const w = [new Date(T0), new Date(T0 + 30 * MIN)] as const;
      expect((await heartRateForWindow(ctx, ...w, { part: "asleep" })).samples).toBe(2);
      expect((await heartRateForWindow(ctx, ...w, { part: "awake" })).samples).toBe(2);
      expect((await heartRateForWindow(ctx, ...w)).samples).toBe(4);
      expect(await heartRateForWindow(ctx, ...w, { part: "asleep" })).toMatchObject({ min: 55, max: 57 });
    });
  });

  it("get_oura_data (workout): every workout carries a heart_rate block, sliced from one load; no readings -> a note", async () => {
    await inTest(async (ctx, tx) => {
      await tx`delete from oura_documents`;
      const doc = (id: string, startMin: number, endMin: number) => tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('workout', ${id}, '2031-03-12', ${new Date(T0 + startMin * MIN)}, ${new Date(T0 + endMin * MIN)},
        ${tx.json({ id, day: "2031-03-12", activity: "walking", start_datetime: new Date(T0 + startMin * MIN).toISOString(), end_datetime: new Date(T0 + endMin * MIN).toISOString() } as never)})`;
      await doc("w1", 0, 10); await doc("w2", 20, 30); await doc("w3", 60, 70);
      for (const m of [0, 3, 6, 9]) await put(tx, m, 120, "oura:awake"); // w1: all in Zone 2 (111-128)
      for (const m of [20, 24, 28]) await put(tx, m, 150, "oura:workout"); // w2: Zone 4
      const r = await getOuraData(ctx, { collection: "workout", start: "2031-03-12", end: "2031-03-12" });
      const byId = Object.fromEntries((r.documents as Record<string, any>[]).map((d) => [d.id, d.heart_rate]));
      expect(byId.w1).toMatchObject({ avg: 120, min: 120, max: 120, samples: 4, window_minutes: 10 });
      expect(byId.w1.minutes_by_zone.z2).toBeGreaterThan(9);
      expect(byId.w2.minutes_by_zone.z4).toBeGreaterThan(9);
      expect(byId.w3).toMatchObject({ samples: 0 });
      expect(byId.w3.note).toMatch(/No stored heart-rate readings/);
      expect((r as Record<string, any>).zones).toMatchObject({ z2: "111-128" });
    });
  });
});

import { getHeartRate } from "@/core/tools/heartRate";
import { ToolError } from "@/core/tools/context";

describe.skipIf(!sql)("get_heart_rate (always rolled back)", () => {
  const ins = (tx: Sql, iso: string, bpm: number, source = "oura:awake") => tx`insert into hr_samples (ts, bpm, source) values (${new Date(iso)}, ${bpm}, ${source})`;

  it("a window crossing local midnight splits into two day rows; each reading counts once", async () => {
    await inTest(async (ctx, tx) => {
      // Pacific midnight 2031-03-13 = 07:00Z (PDT started 2031-03-09)
      await ins(tx, "2031-03-13T06:50:00Z", 100); await ins(tx, "2031-03-13T07:00:00Z", 140); await ins(tx, "2031-03-13T07:02:00Z", 140);
      const r = await getHeartRate(ctx, { start: "2031-03-12T23:00", end: "2031-03-13T01:00", group_by: "day" });
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0]).toMatchObject({ from: "2031-03-12 23:00", to: "2031-03-13 00:00", samples: 1, avg: 100 });
      expect(r.rows[1]).toMatchObject({ from: "2031-03-13 00:00", to: "2031-03-13 01:00", samples: 2, avg: 140 });
      expect(r.rows[0].covered_minutes).toBe(5); // the 06:50 reading holds 5 minutes and is cut at the boundary: never counted across it
      expect(r.zones.z2).toBe("111-128");
    });
  });

  it("the DST change day has a 25-hour row; hourly grouping over 3+ days is refused with advice", async () => {
    await inTest(async (ctx) => {
      const r = await getHeartRate(ctx, { start: "2030-11-03", end: "2030-11-03", group_by: "day" }); // fall-back Sunday 2030-11-03
      expect(r.rows[0].window_minutes).toBe(25 * 60);
      await expect(getHeartRate(ctx, { start: "2031-03-01", end: "2031-03-10", group_by: "hour" })).rejects.toThrow(/3 days or less/);
      await expect(getHeartRate(ctx, { start: "2031-03-01", end: "2031-03-10", group_by: "hour" })).rejects.toBeInstanceOf(ToolError);
      await expect(getHeartRate(ctx, { start: "2030-01-01", end: "2031-03-10" })).rejects.toThrow(/92 days/);
      await expect(getHeartRate(ctx, { start: "2031-03-12", end: "2031-03-11" })).rejects.toThrow(/not after/);
    });
  });

  it("part filters by source, week grouping starts Monday, and a thin window gets a coverage note", async () => {
    await inTest(async (ctx, tx) => {
      await ins(tx, "2031-03-12T09:00:00Z", 55, "oura:sleep"); await ins(tx, "2031-03-12T20:00:00Z", 95, "oura:awake");
      const asleep = await getHeartRate(ctx, { start: "2031-03-12", end: "2031-03-12", part: "asleep" });
      expect(asleep.rows[0]).toMatchObject({ samples: 1, avg: 55 });
      const awake = await getHeartRate(ctx, { start: "2031-03-12", end: "2031-03-12", part: "awake" });
      expect(awake.rows[0]).toMatchObject({ samples: 1, avg: 95 });
      const week = await getHeartRate(ctx, { start: "2031-03-12", end: "2031-03-17", group_by: "week" }); // Wed .. Mon; Monday 03-10 is before the window, 03-17 starts a new week
      expect(week.rows.map((r) => r.from)).toEqual(["2031-03-12 00:00", "2031-03-17 00:00"]);
      const all = await getHeartRate(ctx, { start: "2031-03-12", end: "2031-03-12" });
      expect(all.note).toMatch(/NOT a low heart rate/);
    });
  });
});
