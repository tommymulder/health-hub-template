import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { seedLibrary } from "./helpers/library";
import { logClassWorkout } from "@/core/classes/log";
import type { ClassInput } from "@/core/classes/types";
import { upsertWorkout } from "@/core/hevy/sync";
import type { HevyWorkout } from "@/core/hevy/types";
import { weekStart } from "@/core/time";
import type { ToolCtx } from "@/core/tools/context";
import { getClassHistory } from "@/core/tools/classes";
import { getTrends } from "@/core/tools/trends";
import { getWorkoutDetails } from "@/core/tools/workouts";
import { fakeWriter } from "./helpers/fake-hevy";

// Phase 19 E: the reads that carry completion and "vs last time". Synthetic classes and workouts in March 2031 (real
// ones are cleared INSIDE this always-rolled-back transaction), fake Hevy.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (ctx: ToolCtx, tx: Sql, benchId: string) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await seedLibrary(tx);
      await tx`delete from settings where key like 'class_alias:%'`;
      await tx`delete from oura_documents`; await tx`delete from class_sessions`; await tx`delete from workouts`;
      await tx`insert into oura_documents (collection, id, day, data) values ('sleep', 'n1', '2031-03-12', ${tx.json({ type: "long_sleep", average_hrv: 30, total_sleep_duration: 25200 } as never)})`;
      const [t] = await tx`select id from exercise_templates where title = 'Bench Press (Barbell)'`;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") }, tx, t.id);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const upper = (date: string, setsDone: number, lb: number, over: Partial<ClassInput> = {}): ClassInput => ({
  gym: "Example Gym", class_type: "strength", title: "BUILD - Upper Body", start_at: `${date}T07:00:00-08:00`, duration_min: 50, board_text: "synthetic board", precision: "exact",
  blocks: [{ label: "A", format: "sets", sets: { min: 3, max: 4 }, sets_done: setsDone, movements: [{ movement: "barbell bench press", target: { reps: 8 }, weight: lb }] }],
  ...over,
});
const gym = (id: string, day: string, tpl: string, kg: number, reps: number): HevyWorkout => ({
  id, title: id, routine_id: null, description: null, start_time: `2031-03-${day}T17:00:00Z`, end_time: `2031-03-${day}T17:45:00Z`, updated_at: `2031-03-${day}T17:45:00Z`, created_at: `2031-03-${day}T17:45:00Z`,
  exercises: [{ index: 0, title: "Bench Press (Barbell)", notes: null, exercise_template_id: tpl, superset_id: null, sets: [{ index: 0, type: "normal", weight_kg: kg, reps, distance_meters: null, duration_seconds: null, rpe: null, custom_metric: null }] }],
});

describe.skipIf(!sql)("get_workout_details: vs_last_time for gym workouts too (always rolled back)", () => {
  it("each exercise is compared with the sessions BEFORE that workout; a first time says so", async () => {
    await inTest(async (ctx, tx, bench) => {
      await upsertWorkout(tx, gym("g1", "08", bench, 100, 5), "America/Los_Angeles");
      await upsertWorkout(tx, gym("g2", "15", bench, 105, 5), "America/Los_Angeles");
      const second: any = await getWorkoutDetails(ctx, { workout_id: "g2" });
      const ex = second.exercises[0];
      expect(ex.vs_last_time).toMatchObject({ exercise: "Bench Press (Barbell)", measure: "e1rm", verdict: "better", first_time: false });
      expect(ex.vs_last_time.last).toMatchObject({ date: "2031-03-08", where: "gym" });
      expect(ex.vs_last_time.line).toMatch(/estimated max .* vs .* on 2031-03-08/);
      const first: any = await getWorkoutDetails(ctx, { workout_id: "g1" });
      expect(first.exercises[0].vs_last_time).toMatchObject({ first_time: true });
      expect(first.exercises[0].vs_last_time.line).toMatch(/first time/i);
    });
  });

  it("loads every exercise's history in a fixed number of queries (not a pair per exercise)", async () => {
    await inTest(async (ctx, tx) => {
      const tpls = await tx<{ id: string; title: string }[]>`select id, title from exercise_templates where type = 'weight_reps' order by id limit 5`;
      const mk = (id: string, day: string, n: number, kg: number): HevyWorkout => {
        const w = gym(id, day, tpls[0].id, kg, 5);
        w.exercises = tpls.slice(0, n).map((t, i) => ({ index: i, title: t.title, notes: null, exercise_template_id: t.id, superset_id: null, sets: [{ index: 0, type: "normal", weight_kg: kg, reps: 5, distance_meters: null, duration_seconds: null, rpe: null, custom_metric: null }] }));
        return w;
      };
      await upsertWorkout(tx, mk("h0", "01", 5, 50), "America/Los_Angeles"); // history for all five
      await upsertWorkout(tx, mk("h1", "08", 1, 60), "America/Los_Angeles");
      await upsertWorkout(tx, mk("h5", "15", 5, 70), "America/Los_Angeles");
      let queries = 0;
      const counted = new Proxy(tx, { apply(target, thisArg, args) { if (Array.isArray(args[0]) && "raw" in args[0]) queries++; return Reflect.apply(target as never, thisArg, args); } }) as unknown as Sql;
      const run = async (id: string) => { queries = 0; const d: any = await getWorkoutDetails({ ...ctx, sql: counted }, { workout_id: id }); return { d, queries }; };
      const one = await run("h1"), five = await run("h5");
      expect(five.queries).toBe(one.queries); // 1 exercise or 5: the same number of queries
      expect(five.d.exercises).toHaveLength(5);
      for (const e of five.d.exercises) expect(e.vs_last_time).toMatchObject({ first_time: false, verdict: "better" });
      // and today's workout is never its own "last time": h5's last sessions are h1 (first exercise) or h0
      expect(five.d.exercises[0].vs_last_time.last.date).toBe("2031-03-08");
      expect(five.d.exercises[1].vs_last_time.last.date).toBe("2031-03-01");
    });
  });

  it("an exercise with no Hevy template has no vs_last_time (nothing to look up)", async () => {
    await inTest(async (ctx, tx) => {
      const w = gym("g3", "15", "x", 100, 5);
      w.exercises[0].exercise_template_id = null as never;
      await upsertWorkout(tx, w, "America/Los_Angeles");
      const d: any = await getWorkoutDetails(ctx, { workout_id: "g3" });
      expect(d.exercises[0].vs_last_time).toBeUndefined();
    });
  });
});

describe.skipIf(!sql)("get_class_history and get_trends carry completion (always rolled back, fake Hevy)", () => {
  it("each class has its completion and coaching note; the top level has the completion trend; a movement's sessions are compared with the one before", async () => {
    await inTest(async (ctx) => {
      const { writer } = fakeWriter();
      await logClassWorkout(ctx, writer, upper("2031-03-05", 3, 135)); // 24 of 32 reps = 75%
      await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145, { coaching_note: "Nice one: 100% of the board." })); // 100%
      const h: any = await getClassHistory(ctx, { days: 60 });
      const [newest, oldest] = h.classes;
      expect(newest.completion).toMatchObject({ pct: 100, counted: "1 of 1 movements", blocks_finished: { finished: 1, of: 1 }, estimated: false });
      expect(newest.coaching_note).toBe("Nice one: 100% of the board.");
      expect(oldest.completion.pct).toBe(75);
      expect(h.completion_trend.by_name).toEqual([expect.objectContaining({ title: "BUILD - Upper Body", last: 100, previous: 75, change_points: 25, verdict: null })]);
      expect(h.completion_trend.by_type).toEqual([expect.objectContaining({ class_type: "strength", countable_classes: 2, verdict: null })]);

      const m: any = await getClassHistory(ctx, { days: 60, movement: "bench" });
      const hist = m.movement_history;
      expect(hist).toHaveLength(2);
      expect(hist[0].vs_previous).toBeUndefined(); // the first one has nothing before it
      expect(hist[1].vs_previous).toMatchObject({ verdict: "better", measure: "e1rm" });
    });
  });

  it("get_trends: each week has the average completion of its classes and how many counted; no verdict this early", async () => {
    await inTest(async (ctx) => {
      const { writer } = fakeWriter();
      await logClassWorkout(ctx, writer, upper("2031-03-05", 3, 135));
      await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145));
      const t: any = await getTrends(ctx, { weeks: 4 });
      const w1 = t.weeks.find((w: any) => w.week_of === weekStart("2031-03-05")), w2 = t.weeks.find((w: any) => w.week_of === weekStart("2031-03-12"));
      expect(w1).toMatchObject({ class_completion_avg: 75, classes_counted: 1 });
      expect(w2).toMatchObject({ class_completion_avg: 100, classes_counted: 1 });
      expect(t.summary_last_4_vs_previous_4_weeks).not.toHaveProperty("class_completion_avg");
      expect(t.notes.join(" ")).toMatch(/completion/i);
    });
  });
});
