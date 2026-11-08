import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { excludeAppleSample, getBodyMetrics, getHealthData, listHealthTypes, slopePerDay } from "@/core/tools/apple";
import { kgToLb } from "@/core/units";
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
const ctxOf = (tx: Sql, units: "lb" | "kg" = "lb"): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units, now: () => new Date("2026-10-11T20:00:00Z") });

// 8:00 AM Pacific (PDT, -07:00) on a given October day
const at = (day: number, h = 8) => new Date(Date.UTC(2026, 9, day, h + 7));
async function put(tx: Sql, metric: string, when: Date, value: number, source: string, unit = "kg") {
  await tx`insert into apple_samples (metric, start_at, source, value, unit) values (${metric}, ${when}, ${source}, ${value}, ${unit})`;
}
const clear = (tx: Sql) => tx`delete from apple_samples`;

describe("slopePerDay", () => {
  it("fits a straight line", () => {
    expect(slopePerDay([{ x: 0, y: 90 }, { x: 10, y: 89 }, { x: 20, y: 88 }])).toBeCloseTo(-0.1, 10);
  });
  it("needs two distinct x values", () => {
    expect(slopePerDay([])).toBeNull();
    expect(slopePerDay([{ x: 1, y: 1 }])).toBeNull();
    expect(slopePerDay([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
  });
});

describe.skipIf(!sql)("Apple Health tools (always rolled back)", () => {
  it("body metrics: trend, moving average, rate, scale-only source, hidden excluded", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      // 20 daily weigh-ins, Oct 1..20? Only up to "today" (Oct 11): use Oct -9..11 => build Sep 22..Oct 11 by days
      for (let i = 0; i < 20; i++) {
        const d = new Date(at(11).getTime() - (19 - i) * 86_400_000); // 20 days ending Oct 11, 8am PDT
        await tx`insert into apple_samples (metric, start_at, source, value, unit) values ('weight_body_mass', ${d}, 'Scale App', ${90 - 0.1 * i}, 'kg')`;
      }
      await put(tx, "body_fat_percentage", at(11), 21.04, "Scale App", "%");
      await put(tx, "lean_body_mass", at(11), 70, "Scale App");
      await put(tx, "weight_body_mass", at(10, 0), 50, "Hevy"); // Hevy's own entry must stay out of the trend
      await tx`insert into apple_samples (metric, start_at, source, value, unit) values ('weight_body_mass', '2025-02-08T20:00:00Z', 'Old App', 84, 'kg')`; // older, before the scale
      await put(tx, "weight_body_mass", at(11, 20), 120, "Scale App"); // an evening reading that is a mistake...
      await tx`update apple_samples set hidden = true where value = 120`; // ...hidden

      const r: any = await getBodyMetrics(ctxOf(tx), { days: 30 });
      const last = r.weigh_ins[r.weigh_ins.length - 1];
      expect(last.date).toBe("2026-10-11");
      expect(last.weight).toBe(Math.round(kgToLb(90 - 0.1 * 19) * 10) / 10);
      expect(last.body_fat_pct).toBe(21);
      expect(last.lean_mass).toBe(Math.round(kgToLb(70) * 10) / 10);
      // 7-day avg of the last 7 values: 90-0.1*13 .. 90-0.1*19 => mean 90-0.1*16
      expect(last.avg_7d).toBe(Math.round(kgToLb(90 - 0.1 * 16) * 10) / 10);
      expect(r.summary.rate_per_week).toBeCloseTo(kgToLb(-0.7), 1);
      expect(r.primary_source).toBe("Scale App");
      expect(r.older_weights_from_other_sources).toEqual([{ source: "Old App", readings: 1, first: "2025-02-08", last: "2025-02-08" }]);
      expect(r.other_sources).toEqual([{ source: "Hevy", readings: 1 }]);
      expect(r.weigh_ins.some((w: any) => w.weight === Math.round(kgToLb(50) * 10) / 10)).toBe(false);
    });
  });

  it("with too little history it gives no rate instead of a made-up one", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "weight_body_mass", at(9), 90, "Scale App");
      await put(tx, "weight_body_mass", at(11), 89, "Scale App");
      const r: any = await getBodyMetrics(ctxOf(tx), {});
      expect(r.summary.rate_per_week).toBeNull();
    });
  });

  it("several weigh-ins in a day: the latest one is the day's weight", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "weight_body_mass", at(11, 7), 91, "Scale App");
      await put(tx, "weight_body_mass", at(11, 19), 92, "Scale App");
      const r: any = await getBodyMetrics(ctxOf(tx, "kg"), {});
      expect(r.weigh_ins).toHaveLength(1);
      expect(r.weigh_ins[0].weight).toBe(92);
    });
  });

  it("asking for a source that does not exist, or having no data, is a clear error", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await expect(getBodyMetrics(ctxOf(tx), {})).rejects.toThrow(/No weigh-ins/);
      await put(tx, "weight_body_mass", at(11), 90, "Scale App");
      await expect(getBodyMetrics(ctxOf(tx), { source: "Nope" })).rejects.toThrow(/No weigh-ins from "Nope"/);
    });
  });

  it("list_health_types: counts, sources, dates; get_health_data sums cumulative metrics and averages readings", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "step_count", at(10, 9), 1000, "", "count");
      await put(tx, "step_count", at(10, 15), 500, "", "count");
      await put(tx, "step_count", at(11, 9), 200, "", "count");
      await put(tx, "walking_speed", at(10, 9), 4, "Phone", "km/hr");
      await put(tx, "walking_speed", at(10, 15), 6, "Phone", "km/hr");
      const types: any = await listHealthTypes(ctxOf(tx));
      expect(types.metrics.map((m: any) => [m.metric, m.samples])).toEqual([["step_count", 3], ["walking_speed", 2]]);
      expect(types.metrics[0].sources).toEqual([{ source: "(merged, no source)", samples: 3 }]);

      const steps: any = await getHealthData(ctxOf(tx), { metric: "step_count", start: "2026-10-10", end: "2026-10-11" });
      expect(steps.periods).toEqual([{ date: "2026-10-10", samples: 2, total: 1500 }, { date: "2026-10-11", samples: 1, total: 200 }]);
      const speed: any = await getHealthData(ctxOf(tx), { metric: "walking_speed", start: "2026-10-10", end: "2026-10-11" });
      expect(speed.periods).toEqual([{ date: "2026-10-10", samples: 2, avg: 5, min: 4, max: 6 }]);
      const raw: any = await getHealthData(ctxOf(tx), { metric: "step_count", start: "2026-10-10", end: "2026-10-11", aggregate: "none" });
      expect(raw.count).toBe(3);
      await expect(getHealthData(ctxOf(tx), { metric: "nope" })).rejects.toThrow(/No Apple Health metric called "nope"/);
    });
  });

  it("local-day bucketing: 11 PM Pacific belongs to that Pacific day, not the next UTC day", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "step_count", new Date("2026-10-11T06:30:00Z"), 10, "", "count"); // Oct 10, 11:30 PM PDT
      const r: any = await getHealthData(ctxOf(tx), { metric: "step_count", start: "2026-10-10", end: "2026-10-11" });
      expect(r.periods.map((p: any) => p.date)).toEqual(["2026-10-10"]);
    });
  });

  it("weekly totals start on Monday", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "step_count", at(4), 1, "", "count"); // Sun Oct 4
      await put(tx, "step_count", at(5), 2, "", "count"); // Mon Oct 5
      await put(tx, "step_count", at(11), 4, "", "count"); // Sun Oct 11
      const r: any = await getHealthData(ctxOf(tx), { metric: "step_count", start: "2026-10-01", end: "2026-10-11", aggregate: "week" });
      expect(r.periods.map((p: any) => [p.week_of, p.total])).toEqual([["2026-09-28", 1], ["2026-10-05", 6]]);
    });
  });

  it("weights from get_health_data respect the user's units", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "weight_body_mass", at(11), 100, "Scale App");
      const r: any = await getHealthData(ctxOf(tx), { metric: "weight_body_mass", start: "2026-10-11", end: "2026-10-11", aggregate: "none" });
      expect(r.unit).toBe("lb");
      expect(r.samples[0].value).toBe(220.5);
    });
  });

  it("exclude hides one sample everywhere, restore brings it back, a wrong guess changes nothing", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await put(tx, "weight_body_mass", at(11), 90, "Scale App");
      await put(tx, "weight_body_mass", at(10), 95, "Scale App");
      const when = at(10).toISOString();
      const res: any = await excludeAppleSample(ctxOf(tx), { metric: "weight_body_mass", start_at: when });
      expect(res.sources).toEqual(["Scale App"]);
      let r: any = await getBodyMetrics(ctxOf(tx, "kg"), {});
      expect(r.weigh_ins.map((w: any) => w.date)).toEqual(["2026-10-11"]);
      await expect(excludeAppleSample(ctxOf(tx), { metric: "weight_body_mass", start_at: "2026-01-01T00:00:00Z" })).rejects.toThrow(/Nothing was changed/);
      await excludeAppleSample(ctxOf(tx), { metric: "weight_body_mass", start_at: when, restore: true });
      r = await getBodyMetrics(ctxOf(tx, "kg"), {});
      expect(r.weigh_ins).toHaveLength(2);
      await expect(excludeAppleSample(ctxOf(tx), { metric: "weight_body_mass", start_at: "garbage" })).rejects.toThrow(/timestamp/);
    });
  });
});
