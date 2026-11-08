import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { seedLibrary } from "./helpers/library";
import { logClassWorkout } from "@/core/classes/log";
import type { ClassInput } from "@/core/classes/types";
import type { ToolCtx } from "@/core/tools/context";
import { fakeWriter } from "./helpers/fake-hevy";

// Phase 19 against the real database (always rolled back) with a FAKE Hevy: nothing here can reach Hevy.
// Synthetic classes dated 2031 so real data never interferes.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (ctx: ToolCtx, tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await seedLibrary(tx);
      await tx`delete from settings where key like 'class_alias:%'`;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") }, tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const cls = (over: Partial<ClassInput> = {}): ClassInput => ({
  gym: "Example Gym", class_type: "mixed", start_at: "2031-03-12T07:00:00-07:00", duration_min: 50, board_text: "synthetic board", precision: "exact",
  blocks: [
    { label: "A", format: "sets", sets: { min: 3, max: 3 }, sets_done: 3, movements: [{ movement: "barbell bench press", target: { reps: 8 }, weight: 135 }] },
    { label: "B", format: "for_time", rounds: 3, finish_s: 540, movements: [
      { movement: "ski erg", target: { distance_m: 200, calories: 12 }, done_sets: [{ distance_m: 200, duration_s: 41, calories: 12 }, { distance_m: 200, duration_s: 43, calories: 11 }] },
      { movement: "push up", target: { reps: 40, total: true, share: 0.5, optional: true }, done_sets: [{ reps: 20 }] },
    ] },
  ],
  ...over,
});

describe.skipIf(!sql)("Phase 19 A: the input fields reach the hub record", () => {
  it("coaching_note exists, is nullable, and refuses more than 1,500 characters", async () => {
    await inTest(async (_ctx, tx) => {
      const [col] = await tx`select is_nullable, data_type from information_schema.columns where table_name = 'class_sessions' and column_name = 'coaching_note'`;
      expect(col).toMatchObject({ is_nullable: "YES", data_type: "text" });
      const ins = (note: string | null) => tx`insert into class_sessions (gym, class_type, title, start_at, end_at, window_source, local_date, board_text, planned, precision, coaching_note)
        values ('G', 'strength', 'T', '2031-03-12T14:00:00Z', '2031-03-12T15:00:00Z', 'explicit', '2031-03-12', 'b', '{}'::jsonb, 'exact', ${note})`;
      await ins(null);
      await ins("x".repeat(1500));
      await tx`savepoint s1`;
      await expect(ins("x".repeat(1501))).rejects.toThrow();
      await tx`rollback to savepoint s1`;
    });
  });

  it("saving a class keeps total, share, optional and finish_s in the stored jsonb, and calories in done_sets", async () => {
    await inTest(async (ctx, tx) => {
      const { writer } = fakeWriter();
      const r: any = await logClassWorkout(ctx, writer, cls());
      expect(r.logged).toBe(true);
      const id = r.hub.class_session_id;
      const mv = await tx`select m.movement, m.target, m.done_sets from class_movements m join class_blocks b on b.id = m.block_id where b.session_id = ${id} order by b.id, m.position`;
      const ski = mv.find((m) => m.movement === "ski erg")!;
      expect(ski.target).toMatchObject({ distance_m: 200, calories: 12 });
      expect(ski.done_sets).toEqual([{ distance_m: 200, duration_s: 41, calories: 12 }, { distance_m: 200, duration_s: 43, calories: 11 }]);
      const push = mv.find((m) => m.movement === "push up")!;
      expect(push.target).toMatchObject({ reps: 40, total: true, share: 0.5, optional: true });
      const [s] = await tx`select planned from class_sessions where id = ${id}`;
      expect((s.planned as any).blocks.find((b: any) => b.label === "B").finish_s).toBe(540);
      const [b] = await tx`select rounds from class_blocks where session_id = ${id} and label = 'B'`;
      expect(b.rounds).toBe(3);
    });
  });

  it("calories go in the Hevy exercise note (Hevy has no calories field) and never in a set", async () => {
    await inTest(async (ctx) => {
      const { writer, calls } = fakeWriter();
      await logClassWorkout(ctx, writer, cls());
      const ski = calls.workouts[0].exercises.find((e) => e.notes?.includes("cal"));
      expect(ski, "an exercise note mentions the machine calories").toBeDefined();
      expect(ski!.notes).toMatch(/23 cal/); // 12 + 11
      expect(JSON.stringify(calls.workouts[0].exercises.flatMap((e) => e.sets))).not.toMatch(/calor/i);
    });
  });
});
