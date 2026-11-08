import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { captureIngest } from "@/core/apple/capture";
import { processRaw, processPending } from "@/core/apple/process";
import body from "./fixtures/apple-health/body.json";
import other from "./fixtures/apple-health/other.json";
import workouts from "./fixtures/apple-health/workouts.json";

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
const TZ = "America/Los_Angeles";
const ingest = async (tx: Sql, payload: unknown) => processRaw(tx, (await captureIngest(tx, payload, 1)).id, TZ);
const clear = async (tx: Sql) => { await tx`delete from apple_workouts`; await tx`delete from apple_samples`; await tx`delete from raw_ingest`; };

describe.skipIf(!sql)("Apple Health processing (always rolled back)", () => {
  it("re-sending the same export changes nothing (idempotent), and overlapping batches merge", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await ingest(tx, body);
      const [a] = await tx`select count(*) as n from apple_samples`;
      await ingest(tx, body);
      await ingest(tx, { data: { metrics: [{ name: "weight_body_mass", units: "kg", data: (body.data.metrics[0].data).slice(0, 1) }] } }); // an overlapping batch
      const [b] = await tx`select count(*) as n from apple_samples`;
      expect(Number(a.n)).toBe(5);
      expect(Number(b.n)).toBe(5);
    });
  });

  it("an updated value replaces the old one, and an excluded (hidden) point stays hidden", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await ingest(tx, body);
      await tx`update apple_samples set hidden = true where metric = 'weight_body_mass' and source = 'Hevy'`;
      const changed = structuredClone(body);
      changed.data.metrics[0].data[1].qty = 70;
      await ingest(tx, changed);
      const [row] = await tx`select value, hidden from apple_samples where metric = 'weight_body_mass' and source = 'Hevy'`;
      expect(row).toEqual({ value: 70, hidden: true });
    });
  });

  it("no Oura source ever lands in the clean tables", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const r = await ingest(tx, other);
      await ingest(tx, workouts);
      expect(r.droppedOura).toBe(2);
      const [s] = await tx`select count(*) as n from apple_samples where source ilike '%oura%'`;
      const [w] = await tx`select count(*) as n from apple_workouts where source ilike '%oura%'`;
      expect([Number(s.n), Number(w.n)]).toEqual([0, 0]);
    });
  });

  it("a workout links to the Hevy workout it overlaps by at least half, and to nothing else", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await tx`delete from workouts where id like 'test-link%'`;
      const mk = (id: string, s: string, e: string) => tx`insert into workouts (id, title, start_at, end_at, local_date, raw) values (${id}, 't', ${s}, ${e}, '2026-10-11', '{}'::jsonb)`;
      // Apple's Hevy workout: 2026-10-11 07:48:37Z - 07:50:01Z
      await mk("test-link-hit", "2026-10-11T07:48:00Z", "2026-10-11T07:51:00Z");
      await mk("test-link-miss", "2026-10-11T09:00:00Z", "2026-10-11T10:00:00Z");
      await ingest(tx, workouts);
      const rows = await tx`select linked_workout_id as l, source from apple_workouts order by source`;
      expect(rows.map((r) => [r.source, r.l])).toEqual([["Hevy", "test-link-hit"], ["Test Watch", null]]);
    });
  });

  it("processPending handles only unprocessed bodies, reports a broken one without stopping, and reprocess_all redoes everything", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await captureIngest(tx, body, 1);
      await captureIngest(tx, workouts, 1);
      await captureIngest(tx, { data: { metrics: [{ name: "x", units: "u", data: [{ date: "2026-10-01 00:00:00 -0700", qty: 1, source: "S" }] }] } }, 1);
      const first = await processPending(tx, TZ);
      expect(first).toMatchObject({ bodies_found: 3, processed: 3, failed: 0, remaining: 0, workouts: 2 });
      const again = await processPending(tx, TZ);
      expect(again).toMatchObject({ bodies_found: 0, processed: 0 });
      const redo = await processPending(tx, TZ, { all: true });
      expect(redo.processed).toBe(3);
      const [n] = await tx`select count(*) as n from apple_samples`;
      expect(Number(n.n)).toBe(6); // no duplicates after redoing everything
    });
  });
});
