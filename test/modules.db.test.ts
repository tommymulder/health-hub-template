import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import type { ModuleSet } from "@/core/modules";
import type { ToolCtx } from "@/core/tools/context";
import { getRecovery } from "@/core/tools/recovery";
import { getTrends } from "@/core/tools/trends";

// With an optional module off, the core tools that used to carry its fields leave them out (DESIGN Phase 18).
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values
        ('daily_readiness', 'mod-r', '2099-04-10', null, null, ${tx.json({ score: 80 } as never)}),
        ('daily_sleep', 'mod-s', '2099-04-10', null, null, ${tx.json({ score: 75 } as never)}),
        ('sleep', 'mod-n', '2099-04-10', '2099-04-10T06:00:00Z', '2099-04-10T14:00:00Z', ${tx.json({ type: "long_sleep", total_sleep_duration: 28800, average_hrv: 40, lowest_heart_rate: 52 } as never)})`;
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const ctx = (tx: Sql, modules?: ModuleSet): ToolCtx => ({ sql: tx, timezone: "UTC", units: "kg", modules, now: () => new Date("2099-04-10T18:00:00Z") });
const ALL: ModuleSet = new Set(["checkins", "classes", "genetics", "events"]);
const NONE: ModuleSet = new Set();

describe.skipIf(!sql)("core tools follow the module switches (always rolled back)", () => {
  it("get_recovery: the check-in and bathroom-trip fields exist only while their module is on", async () => {
    await inRollback(async (tx) => {
      await tx`insert into events (type, at, source) values ('bathroom', '2099-04-10T10:00:00Z', 'shortcut')`; // so a trips block exists to be hidden
      const on: any = await getRecovery(ctx(tx, ALL), { days: 3 });
      expect(on).toHaveProperty("morning_checkin");
      expect(on.days[0]).toHaveProperty("night");
      const off: any = await getRecovery(ctx(tx, NONE), { days: 3 });
      expect(off).not.toHaveProperty("morning_checkin");
      expect(off.days[0]).not.toHaveProperty("night");
      expect(off.days[0]).not.toHaveProperty("wake_day_total");
      expect(JSON.stringify(off.notes)).not.toMatch(/morning_checkin|Action Button/);
    });
  });

  it("get_recovery with no modules given behaves as everything on (tests and scripts)", async () => {
    await inRollback(async (tx) => {
      expect(await getRecovery(ctx(tx), { days: 3 })).toHaveProperty("morning_checkin");
    });
  });

  it("get_trends: class-completion and bathroom-trip fields exist only while their module is on", async () => {
    await inRollback(async (tx) => {
      const has = (r: any, key: string) => r.weeks.some((w: object) => key in w) || JSON.stringify(r.notes).includes(key);
      const on: any = await getTrends(ctx(tx, ALL), { weeks: 2 });
      expect(on.weeks.length).toBeGreaterThan(0);
      expect(has(on, "class_completion_avg")).toBe(true);
      expect(has(on, "nights_tracked")).toBe(true);
      const off: any = await getTrends(ctx(tx, NONE), { weeks: 2 });
      for (const key of ["class_completion_avg", "classes_counted", "trips_per_tracked_night", "nights_tracked", "ring_wakeups_per_night", "day_trips_per_tracked_day"]) {
        expect(has(off, key), key).toBe(false);
      }
      const classesOnly: any = await getTrends(ctx(tx, new Set(["classes"])), { weeks: 2 });
      expect(has(classesOnly, "class_completion_avg")).toBe(true);
      expect(has(classesOnly, "nights_tracked")).toBe(false);
    });
  });
});
