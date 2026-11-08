import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { getCheckins } from "@/core/checkins/read";
import { getRecovery } from "@/core/tools/recovery";
import { getTrends } from "@/core/tools/trends";
import { weekStart } from "@/core/time";
import type { ToolCtx } from "@/core/tools/context";

// Synthetic data only (year 2031); every test is rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try { await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const ctxOf = (tx: Sql): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date("2031-05-04T20:00:00Z") });

// Night 1 (wake-up date 2031-05-02): in bed 06:40Z, epochs of 5 min. Wake-ups at +30..+40 and +65..+70 min.
const BED1 = Date.parse("2031-05-02T06:40:00Z");
const PHASES1 = "44" + "2222" + "44" + "22222" + "4" + "222" + "444";
const MIN = 60_000;
async function seed(tx: Sql) {
  await tx`delete from events`; await tx`delete from oura_documents`; await tx`delete from morning_checkins`;
  const night = (id: string, day: string, bed: number, end: number, phases: string, secs = 25000) => tx`
    insert into oura_documents (collection, id, day, start_at, end_at, data) values ('sleep', ${id}, ${day}, ${new Date(bed)}, ${new Date(end)},
    ${tx.json({ type: "long_sleep", total_sleep_duration: secs, average_hrv: 30, sleep_phase_5_min: phases } as never)})`;
  await night("n1", "2031-05-02", BED1, BED1 + 100 * MIN, PHASES1);
  const BED2 = Date.parse("2031-05-03T06:40:00Z");
  await night("n2", "2031-05-03", BED2, BED2 + 100 * MIN, "2222");
  // a nap on 05-03 that must never be used as the night
  await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('sleep', 'nap', '2031-05-03', '2031-05-03T21:00:00Z', '2031-05-03T21:30:00Z',
    ${tx.json({ type: "sleep", total_sleep_duration: 1800, sleep_phase_5_min: "4444" } as never)})`;
  const press = (iso: number | string, extra = "") => tx`insert into events (type, at, source, approximate) values ('bathroom', ${new Date(iso)}, 'shortcut', ${extra === "approx"})`;
  await press(BED1 + 35 * MIN); await press(BED1 + 60 * MIN); await press(BED1 + 91 * MIN, "approx");
  await tx`insert into events (type, at, source, hidden) values ('bathroom', ${new Date(BED1 + 36 * MIN)}, 'shortcut', true)`; // a mis-press: hidden, never counted
  await press("2031-05-02T20:00:00Z"); await press("2031-05-02T22:30:00Z"); // 13:00 and 15:30 PDT: day trips of 05-02
  await press(BED2 + 30 * MIN); // night 2: one press, no ring wake-up
}

describe.skipIf(!sql)("get_recovery with bathroom trips (always rolled back)", () => {
  it("shows the night's trips with times and ids, ring wake-ups, matching, the day's trips and the wake-day total", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const r: any = await getRecovery(ctxOf(tx), { days: 5 });
      const d = r.days.find((x: any) => x.day === "2031-05-02");
      expect(d.night.bathroom_trips.count).toBe(3);
      expect(d.night.bathroom_trips.times.map((t: any) => t.time)).toEqual(["2031-05-02 00:15", "2031-05-02 00:40", "2031-05-02 01:11"]);
      expect(d.night.bathroom_trips.times.map((t: any) => t.approximate)).toEqual([false, false, true]);
      expect(d.night.bathroom_trips.times.every((t: any) => Number.isInteger(t.id))).toBe(true);
      expect(d.night.bathroom_trips.window.kind).toBe("ring");
      expect(d.night.ring).toEqual({ wake_ups: 2, longest_unbroken_sleep_min: 25, awake_min_in_wakeups: 15 });
      expect(d.night.matched).toMatchObject({ presses_matched: 2, presses_without_wakeup: 1, wakeups_without_press: 1 });
      expect(d.daytime.trips.count).toBe(2);
      expect(d.daytime.minutes_between).toEqual({ average: 150, longest: 150, shortest: 150 });
      expect(d.daytime.first.time).toBe("2031-05-02 13:00");
      expect(d.daytime.last.time).toBe("2031-05-02 15:30");
      expect(d.wake_day_total).toBe(5);
    });
  });

  it("a nap is never the night; a day with no presses is not_tracked; a tracked night without a ring wake-up is just a count", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const d3: any = ((await getRecovery(ctxOf(tx), { days: 5 })) as any).days.find((x: any) => x.day === "2031-05-03");
      expect(d3.night.ring.wake_ups).toBe(0); // from the 4-epoch long_sleep "2222", not the nap's "4444"
      expect(d3.night.bathroom_trips.count).toBe(1);
      expect(d3.daytime).toEqual({ not_tracked: true });
      expect(d3.wake_day_total).toBeUndefined();
    });
  });

  it("with no presses at all nothing is reported about trips (no fake zeros), but the ring's wake-ups still show", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      await tx`delete from events`;
      const d: any = ((await getRecovery(ctxOf(tx), { days: 5 })) as any).days.find((x: any) => x.day === "2031-05-02");
      expect(d.night.bathroom_trips).toBeUndefined();
      expect(d.night.ring.wake_ups).toBe(2);
      expect(d.daytime).toBeUndefined();
    });
  });

  it("a night with no presses is 0 once tracking has started, flagged when the ring saw wake-ups", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      await tx`delete from events where at < '2031-05-03T00:00:00Z' and at > '2031-05-02T06:00:00Z' and at < '2031-05-02T09:00:00Z'`; // remove night 1's presses
      await tx`insert into events (type, at, source) values ('bathroom', '2031-05-01T18:00:00Z', 'shortcut')`; // tracking started the day before
      const d: any = ((await getRecovery(ctxOf(tx), { days: 5 })) as any).days.find((x: any) => x.day === "2031-05-02");
      expect(d.night.bathroom_trips.count).toBe(0);
      expect(d.night.flag).toBe("no_presses_but_ring_wakeups");
    });
  });
});

describe.skipIf(!sql)("get_trends and get_checkins with bathroom trips (always rolled back)", () => {
  it("weekly averages over tracked days and nights, with nights tracked", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      const r: any = await getTrends(ctxOf(tx), { weeks: 4 });
      const wk = r.weeks.find((w: any) => w.week_of === weekStart("2031-05-02"));
      expect(wk).toMatchObject({
        trips_per_tracked_night: 2, // 3 and 1
        nights_tracked: 2,
        ring_wakeups_per_night: 1, // 2 and 0
        longest_unbroken_sleep_min: 22.5, // 25 and 20
        day_trips_per_tracked_day: 2, // only 05-02 has day presses; 05-03 is not_tracked and left out
        minutes_between_day_trips: 150,
      });
      expect(r.summary_last_4_vs_previous_4_weeks).not.toHaveProperty("trips_per_tracked_night"); // no verdict without enough tracked weeks
      expect(r.notes.join(" ")).toMatch(/trips/i);
    });
  });

  it("each rated morning carries that night's trips and ring wake-ups", async () => {
    await inRollback(async (tx) => {
      await seed(tx);
      await tx`insert into morning_checkins (day, rating, logged_at, source) values ('2031-05-02', 3, '2031-05-02T16:00:00Z', 'shortcut')`;
      const c: any = await getCheckins(ctxOf(tx), { days: 5 });
      const m = c.days.find((x: any) => x.day === "2031-05-02");
      expect(m.bathroom_trips).toMatchObject({ count: 3 });
      expect(m.ring_wake_ups).toEqual({ wake_ups: 2, longest_unbroken_sleep_min: 25 });
    });
  });
});
