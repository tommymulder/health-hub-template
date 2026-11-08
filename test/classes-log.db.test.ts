import { describe, it, expect, afterAll } from "vitest";
import fixture from "./fixtures/class-boards/example-board-expected.json";
import { createSql, type Sql } from "@/core/db";
import { seedLibrary } from "./helpers/library";
import { logClassWorkout } from "@/core/classes/log";
import type { BlockInput, ClassInput } from "@/core/classes/types";
import { HevyWriteError, type CustomExerciseBody, type HevyWriteApi, type WorkoutBody } from "@/core/hevy/write";
import { ToolError, type ToolCtx } from "@/core/tools/context";
import { lbToKg } from "@/core/units";

// Real database (always rolled back) + a FAKE Hevy: nothing here can reach Hevy. Classes are dated March 2031 so real data never interferes.
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
      // A custom 'Hollow Hold' or remembered matches may already exist in a real database: start clean INSIDE this always-rolled-back transaction.
      await tx`delete from exercise_templates where title = 'Hollow Hold'`;
      await tx`delete from settings where key like 'class_alias:%'`;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") }, tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const PHOTO = "2031-03-12T06:55:00-07:00"; // the board photo; the class (per the seeded Oura record) ran 07:02-08:00
async function seedOuraClass(tx: Sql, day = "2031-03-12", start = "2031-03-12T14:02:00Z", end = "2031-03-12T15:00:00Z") {
  await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('workout', ${"ow-" + start}, ${day}, ${start}, ${end}, ${tx.json({ activity: "fitnessClass", source: "workout_heart_rate", calories: 455 })})`;
}

function fakeWriter(over: Partial<HevyWriteApi> = {}) {
  const calls = { workouts: [] as WorkoutBody[], templates: [] as CustomExerciseBody[] };
  let n = 0;
  const writer: HevyWriteApi = {
    listRoutineFolders: async () => [], getRoutine: async () => ({}),
    createRoutineFolder: async () => { throw new Error("unused"); }, createRoutine: async () => { throw new Error("unused"); }, updateRoutine: async () => { throw new Error("unused"); },
    createExerciseTemplate: async (b) => { calls.templates.push(b); return { raw: { id: `CUST${++n}` } }; },
    createWorkout: async (b) => {
      calls.workouts.push(b);
      const id = `hw-${calls.workouts.length}`;
      return { raw: { workout: [{ id, title: b.title, description: b.description, start_time: b.start_time, end_time: b.end_time, updated_at: b.end_time, created_at: b.end_time,
        exercises: b.exercises.map((e, i) => ({ index: i, title: e.exercise_template_id, exercise_template_id: e.exercise_template_id, superset_id: e.superset_id, notes: e.notes,
          sets: e.sets.map((s, j) => ({ index: j, ...s })) })) }] } };
    },
    ...over,
  };
  return { writer, calls };
}

const board = fixture.blocks as unknown as BlockInput[];
const done: Record<string, number> = { A: 4, B: 3, C: 3, D: 3 };
const wt: Record<string, number | number[]> = {
  "barbell strict press": [75, 85, 95, 105], "pull up": 40, "dumbbell bicep curl": 25, "barbell bench press": [135, 155, 165, 175], "barbell pendlay row": 115,
  "cable crunch": 60, "dumbbell chest press": 40, "dumbbell single arm row": 55, "dumbbell overhead tricep extension": 30,
};
function classInput(over: Partial<ClassInput> = {}, withHollow = true): ClassInput {
  return {
    gym: "Example Gym", class_type: "strength", photo_time: PHOTO, board_text: fixture.board_text, precision: "partial", user_notes: "felt good",
    blocks: board.map((b) => ({
      ...b, sets_done: done[b.label],
      movements: b.movements.map((m) => ({
        ...m, weight: wt[m.movement],
        ...(m.movement === "ab mat sit-up" ? { done_sets: [{ reps: 20 }, { reps: 18 }, { reps: 16 }] } : {}),
        ...(withHollow && m.movement === "hollow hold" ? { create_custom: { exercise_type: "duration", muscle_group: "abdominals", equipment: "none" } } : {}),
      })),
    })) as BlockInput[],
    ...over,
  };
}
const tx0 = (ctx: ToolCtx) => ctx.sql;
const count = async (tx: Sql, t: string, where = "true") => Number((await tx.unsafe(`select count(*) as n from ${t} where ${where}`))[0].n);
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ToolError);
  expect((e as Error).message).toMatch(re);
};

describe.skipIf(!sql)("log_class_workout (fake Hevy, rolled-back DB)", () => {
  it("DRY RUN: finds the class in Oura (not the photo time), matches movements to the gym's Hevy exercises, writes nothing", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, classInput(), { dry_run: true })) as Record<string, any>;
      expect(r.dry_run).toBe(true);
      expect(r.window).toMatchObject({ start_local: "2031-03-12 07:02", end_local: "08:00", minutes: 58, source: "oura_workout" }); // not the 6:55 photo time
      const ex = (name: string) => r.blocks.flatMap((b: any) => b.exercises).find((e: any) => e.movement === name);
      expect(ex("barbell pendlay row")).toMatchObject({ hevy_exercise: "Pendlay Row (Barbell)", matched_by: "alias_map" });
      expect(ex("barbell bench press").hevy_exercise).toBe("Bench Press (Barbell)"); // the SAME exercise as the gym, so progress merges
      expect(ex("barbell strict press").sets.map((s: any) => [s.reps, s.weight])).toEqual([[8, 75], [6, 85], [4, 95], [2, 105]]);
      expect(ex("hollow hold").matched_by).toBe("NEW custom exercise");
      expect(r.new_custom_exercises).toEqual([{ title: "Hollow Hold", exercise_type: "duration", muscle_group: "abdominals", equipment: "none" }]);
      expect(r.warnings.join(" ")).toMatch(/NEW custom exercise.*never be edited or deleted/);
      expect(calls.workouts).toHaveLength(0);
      expect(calls.templates).toHaveLength(0);
      expect(await count(tx, "class_sessions", "start_at >= '2031-01-01'")).toBe(0);
      expect(await count(tx, "hevy_writes", "created_at > now() - interval '1 minute'")).toBe(0);
    });
  });

  it("an unmatched movement is NEVER silently created: it is reported with the closest options", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      await rejects(logClassWorkout(ctx, writer, classInput({}, false), { dry_run: true }), /"hollow hold": no matching Hevy exercise.*Hollow Rock.*create_custom/s);
      await rejects(logClassWorkout(ctx, writer, classInput({}, false)), /hollow hold/);
      expect(calls.templates).toHaveLength(0);
      expect(calls.workouts).toHaveLength(0);
    });
  });

  it("REAL RUN: creates the custom exercise first, then the workout (supersets per block), then the hub record, and remembers the matches", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(r.logged).toBe(true);
      expect(calls.templates).toEqual([{ title: "Hollow Hold", exercise_type: "duration", equipment_category: "none", muscle_group: "abdominals", other_muscles: [] }]);
      expect(calls.workouts).toHaveLength(1);

      const w = calls.workouts[0];
      expect(w.title).toBe("Example Gym — Strength");
      expect(w.start_time).toBe("2031-03-12T14:02:00.000Z");
      expect(w.end_time).toBe("2031-03-12T15:00:00.000Z");
      expect(w.exercises).toHaveLength(13);
      expect(w.exercises.map((e) => e.superset_id)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
      expect(w.exercises.some((e) => e.exercise_template_id === "CUST1")).toBe(true); // the freshly created hollow hold
      const bench = w.exercises[3];
      expect(bench.sets.map((s) => [s.reps, s.weight_kg])).toEqual([[8, lbToKg(135)], [6, lbToKg(155)], [4, lbToKg(165)]]);
      expect(w.description).toMatch(/^📊 Board: /); // Phase 19: a short summary of the numbers (no coaching_note was sent), never the station list
      expect(w.description).not.toMatch(/^A\nOverhead Press/);
      expect(w.description).not.toContain("BARBELL STRICT PRESS X 8-6-4-2"); // the board and the voice note stay in the hub
      expect((await tx`select board_text, user_notes from class_sessions where hevy_workout_id = 'hw-1'`)[0]).toMatchObject({ user_notes: "felt good" });

      expect(r.hevy).toMatchObject({ workout_id: "hw-1", exercises: 13 });
      expect(r.new_custom_exercises).toEqual([{ title: "Hollow Hold", id: "CUST1" }]);

      // audit: custom exercise + workout, both ok
      const audit = await tx`select kind, outcome, hevy_id from hevy_writes where created_at > now() - interval '1 minute' order by id`;
      // (the workout's row is opened FIRST on purpose, so the duplicate guard is live while custom exercises are being created)
      expect(audit.map((a) => [a.kind, a.outcome, a.hevy_id]).sort()).toEqual([["exercise_template", "ok", "CUST1"], ["workout", "ok", "hw-1"]]);

      // hub record: planned vs done
      const [s] = await tx`select class_type, window_source, hevy_workout_id, precision, user_notes from class_sessions where start_at >= '2031-01-01'`;
      expect(s).toMatchObject({ class_type: "strength", window_source: "oura_workout", hevy_workout_id: "hw-1", precision: "partial", user_notes: "felt good" });
      expect(await count(tx, "class_blocks", "session_id in (select id from class_sessions where start_at >= '2031-01-01')")).toBe(4);
      const mv = await tx`select movement, exercise_template_id, done_sets, assumed from class_movements where movement = 'barbell strict press' and block_id in (select b.id from class_blocks b join class_sessions s on s.id = b.session_id where s.start_at >= '2031-01-01')`;
      expect(mv[0].done_sets).toEqual([8, 6, 4, 2].map((reps, i) => ({ reps, weight_kg: lbToKg([75, 85, 95, 105][i]) }))); // stored in kg (D6)
      expect(mv[0].exercise_template_id).toBe("7B8D84E8"); // Hevy's standard Overhead Press (Barbell)

      // the workout is visible to the read tools immediately, and the custom exercise is in the template table
      expect(await count(tx, "workouts", "id = 'hw-1'")).toBe(1);
      expect(await count(tx, "exercise_templates", "id = 'CUST1' and is_custom")).toBe(1);
      const [alias] = await tx`select value from settings where key = 'class_alias:barbell pendley row'`;
      expect(alias).toBeUndefined(); // the board's typo is only remembered if it was used
      expect((await tx`select value from settings where key = 'class_alias:barbell pendlay row'`)[0].value).toBe("018ADC12");
      expect(r.oura.heart_rate).toBeDefined();
    });
  });

  it("REAL reply shape: Hevy answers a new custom exercise with a BARE STRING id, and the class is logged (this stopped with \"couldn't read its id\" on the first live write)", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const base = fakeWriter();
      const id = "1b665ff4-8470-493c-bcdf-fdd4381e567d";
      const writer: HevyWriteApi = { ...base.writer, createExerciseTemplate: async (b) => { base.calls.templates.push(b); return { raw: id }; } };
      const r = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(r.logged).toBe(true);
      expect(r.new_custom_exercises).toEqual([{ title: "Hollow Hold", id }]);
      expect(base.calls.workouts[0].exercises.some((e) => e.exercise_template_id === id)).toBe(true);
    });
  });

  it("if the new exercise's id truly can't be read, the workout is NOT sent, and a retry finds the exercise by name", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const base = fakeWriter();
      const writer: HevyWriteApi = { ...base.writer, createExerciseTemplate: async (b) => { base.calls.templates.push(b); return { raw: { surprise: true } }; } };
      await rejects(logClassWorkout(ctx, writer, classInput()), /couldn't read its id.*sync_now/s);
      expect(base.calls.workouts).toHaveLength(0);
      await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at) values ('SYNCED1', 'Hollow Hold', 'duration', 'abdominals', '[]'::jsonb, 'none', true, now())`; // what sync_now brings in
      const r = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(r.logged).toBe(true);
      expect(base.calls.templates).toHaveLength(1); // never created twice
      expect(base.calls.workouts[0].exercises.some((e) => e.exercise_template_id === "SYNCED1")).toBe(true);
    });
  });

  it("DUPLICATE GUARD: a class within 2 hours of a logged one is not logged again", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      await logClassWorkout(ctx, writer, classInput());
      const again = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(again).toMatchObject({ already_logged: true });
      expect(calls.workouts).toHaveLength(1);
      expect(calls.templates).toHaveLength(1);
      expect(await count(tx, "class_sessions", "start_at >= '2031-01-01'")).toBe(1);
      // a class on another day is fine
      await seedOuraClass(tx, "2031-03-14", "2031-03-14T14:00:00Z", "2031-03-14T15:00:00Z");
      const next = (await logClassWorkout(ctx, writer, classInput({ photo_time: "2031-03-14T06:55:00-07:00" }))) as Record<string, any>;
      expect(next.logged).toBe(true);
      expect(calls.workouts).toHaveLength(2);
      expect(calls.templates).toHaveLength(1); // Hollow Hold already exists now: never created twice
    });
  });

  it("REDO: replacing a class is refused while its Hevy copy exists, and works once the user deleted it in Hevy (and a sync saw that)", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      const first = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      const oldId = first.hub.class_session_id as number;
      // still in Hevy: refused, even as a dry run, and nothing is sent
      await rejects(logClassWorkout(ctx, writer, classInput({ replaces_session_id: oldId }), { dry_run: true }), /still in Hevy.*delete it in the Hevy app.*sync_now/);
      await rejects(logClassWorkout(ctx, writer, classInput({ replaces_session_id: 999_999_999 })), /no class with that id/);
      expect(calls.workouts).toHaveLength(1);
      // the user deletes it in the app; the next Hevy sync marks it deleted
      await tx`update workouts set deleted = true where id = 'hw-1'`;
      const preview = (await logClassWorkout(ctx, writer, classInput({ replaces_session_id: oldId }), { dry_run: true })) as Record<string, any>;
      expect(preview.replaces).toMatchObject({ session_id: oldId, hevy_workout_id: "hw-1" });
      expect(preview.warnings.join(" ")).toMatch(/REPLACES/);
      const redo = (await logClassWorkout(ctx, writer, classInput({ replaces_session_id: oldId }))) as Record<string, any>;
      expect(redo.logged).toBe(true); // the duplicate guard ignores the class being replaced
      expect(redo.hub.replaced_session_id).toBe(oldId);
      expect(calls.workouts).toHaveLength(2);
      expect(await count(tx, "class_sessions", `id = ${oldId}`)).toBe(0); // the old record (and its blocks, by cascade) is gone
      expect(await count(tx, "class_sessions", "start_at >= '2031-01-01'")).toBe(1);
      // without replaces_session_id, the guard still blocks a second class at the same time
      expect(await logClassWorkout(ctx, writer, classInput())).toMatchObject({ already_logged: true });
    });
  });

  it("REDO TWICE (2026-10-15): an earlier attempt the user deleted in Hevy no longer blocks the next redo", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      const first = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>; // hw-1
      await tx`update workouts set deleted = true where id = 'hw-1'`;
      const second = (await logClassWorkout(ctx, writer, classInput({ replaces_session_id: first.hub.class_session_id }))) as Record<string, any>; // hw-2
      expect(second.logged).toBe(true);
      await tx`update workouts set deleted = true where id = 'hw-2'`;
      // before the fix, hw-1's write (deleted, but not the session being replaced) blocked this forever
      const preview = (await logClassWorkout(ctx, writer, classInput({ replaces_session_id: second.hub.class_session_id }), { dry_run: true })) as Record<string, any>;
      expect(preview.would_be_refused).toBeUndefined();
      const third = (await logClassWorkout(ctx, writer, classInput({ replaces_session_id: second.hub.class_session_id }))) as Record<string, any>;
      expect(third.logged).toBe(true);
      expect(calls.workouts).toHaveLength(3);
      expect(await count(tx, "class_sessions", "start_at >= '2031-01-01'")).toBe(1);
    });
  });

  it("the DRY RUN runs the duplicate check too: a preview that would be refused says so (and how to redo)", async () => {
    await inTest(async (ctx) => {
      await seedOuraClass(tx0(ctx));
      const { writer, calls } = fakeWriter();
      const first = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      const preview = (await logClassWorkout(ctx, writer, classInput(), { dry_run: true })) as Record<string, any>;
      expect(preview.dry_run).toBe(true);
      expect(preview.would_be_refused).toMatchObject({ already_logged: true, where: "the hub", session_id: first.hub.class_session_id });
      expect(preview.would_be_refused.message).toMatch(new RegExp(`replaces_session_id ${first.hub.class_session_id}`));
      expect(preview.warnings.join(" ")).toMatch(/would be REFUSED/);
      expect(calls.workouts).toHaveLength(1); // the preview sent nothing
    });
  });

  it("CARDIO MACHINES: distances go to Hevy as meters in the distance field; 'bike' is Cycling; reps alone on a distance exercise stop the dry run", async () => {
    await inTest(async (ctx) => {
      const { writer, calls } = fakeWriter();
      const cardio = (ski: Record<string, unknown>): ClassInput => ({
        gym: "Example Gym", class_type: "strength_hiit", start_at: "2031-03-16T17:30:00-07:00", duration_min: 60, board_text: "200M SKI / 16 WALL BALLS / 400M BIKE", precision: "exact",
        blocks: [
          { label: "A", format: "other", rounds: 3, sets_done: 2, movements: [{ movement: "ski", target: ski }, { movement: "wall ball", target: { reps: 16 }, weight: 10 }] },
          { label: "C", format: "other", rounds: 3, sets_done: 2, movements: [{ movement: "bike", target: { distance_m: 400 } }] },
        ],
      });
      await rejects(logClassWorkout(ctx, writer, cardio({ reps: 150 }), { dry_run: true }), /"ski" is "Ski Erg" in Hevy, which records a distance \(distance_m, in meters\)/);
      const r = (await logClassWorkout(ctx, writer, cardio({ distance_m: 200 }))) as Record<string, any>;
      expect(r.logged).toBe(true);
      const body = calls.workouts[0];
      const [ski, wall, bike] = body.exercises;
      expect(ski.sets).toEqual([expect.objectContaining({ distance_meters: 200, reps: null, weight_kg: null }), expect.objectContaining({ distance_meters: 200 })]);
      expect(wall.sets[0]).toMatchObject({ reps: 16, weight_kg: lbToKg(10), distance_meters: null });
      expect(r.blocks[1].exercises[0]).toMatchObject({ movement: "bike", hevy_exercise: "Cycling", matched_by: "alias_map" });
      expect(bike.sets[0]).toMatchObject({ distance_meters: 400, reps: null });
      expect(body.description).toMatch(/^📊 Board: /); // the sets live in the workout itself; the description is the note, not the station list
      expect(body.description).not.toContain("Ski Erg: 2 x 200 m");
    });
  });

  it("a refused workout (400) is recorded as rejected, nothing is double-created, and a retry reuses the custom exercise", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      let refuse = true;
      const base = fakeWriter();
      const writer: HevyWriteApi = { ...base.writer, createWorkout: async (b) => {
        if (refuse) throw new HevyWriteError("Hevy rejected the request as invalid: bad set.", 400, false);
        return base.writer.createWorkout(b);
      } };
      await rejects(logClassWorkout(ctx, writer, classInput()), /rejected.*Nothing was created in Hevy/s);
      expect((await tx`select outcome from hevy_writes where kind = 'workout' and created_at > now() - interval '1 minute'`)[0].outcome).toBe("rejected");
      expect(base.calls.templates).toHaveLength(1); // the custom exercise DID get created (it can't be undone)
      refuse = false;
      const r = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(r.logged).toBe(true);
      expect(base.calls.templates).toHaveLength(1); // ... and the retry found it by name instead of creating a second one
      expect(base.calls.workouts).toHaveLength(1);
    });
  });

  it("an UNCONFIRMED workout (no reply) says so and blocks the retry that could duplicate it", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const base = fakeWriter();
      const writer: HevyWriteApi = { ...base.writer, createWorkout: async (b) => { base.calls.workouts.push(b); throw new HevyWriteError("No response from Hevy (ECONNRESET)", undefined, true); } };
      await rejects(logClassWorkout(ctx, writer, classInput()), /may or may not have been created.*workout history/s);
      const retry = (await logClassWorkout(ctx, writer, classInput())) as Record<string, any>;
      expect(retry.already_logged).toBe(true);
      expect(retry.message).toMatch(/unconfirmed/);
      expect(base.calls.workouts).toHaveLength(1);
    });
  });

  it("a failing custom-exercise step stops BEFORE the workout is sent", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const base = fakeWriter();
      const writer: HevyWriteApi = { ...base.writer, createExerciseTemplate: async () => { throw new HevyWriteError("Hevy refused (403): Exceeds custom exercise limit. This usually means an account limit was reached (custom exercises).", 403, false); } };
      await rejects(logClassWorkout(ctx, writer, classInput()), /custom exercises/);
      expect(base.calls.workouts).toHaveLength(0);
      expect((await tx`select outcome from hevy_writes where kind = 'workout' and created_at > now() - interval '1 minute'`)[0].outcome).toBe("rejected");
    });
  });

  it("log_to_hevy:false saves only in the hub, never calls Hevy, and tolerates unmatched movements", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer, calls } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, classInput({ log_to_hevy: false }, false))) as Record<string, any>;
      expect(r).toMatchObject({ logged: true, hevy: null });
      expect(calls.workouts).toHaveLength(0);
      expect(calls.templates).toHaveLength(0);
      const [s] = await tx`select hevy_workout_id from class_sessions where start_at >= '2031-01-01'`;
      expect(s.hevy_workout_id).toBeNull();
      expect(await count(tx, "hevy_writes", "created_at > now() - interval '1 minute'")).toBe(0);
      expect((await logClassWorkout(ctx, writer, classInput({ log_to_hevy: false }, false)) as any).already_logged).toBe(true); // the guard works hub-only too
    });
  });

  it("'about 75%': sets are scaled down (3 of 4), flagged estimated, and the preview says so", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const input = classInput({ completion_pct: 75, precision: "estimated" }, true);
      input.blocks.forEach((b) => { delete b.sets_done; });
      const { writer } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, input, { dry_run: true })) as Record<string, any>;
      const press = r.blocks[0].exercises[0];
      expect(press.sets.map((s: any) => s.reps)).toEqual([8, 6, 4]); // 75% of the 4-set top end
      expect(press.assumed).toBe(true);
      expect(r.assumptions.join(" ")).toMatch(/3 of 4.*75%/);
    });
  });

  it("a max-rep movement with no count is left out and reported, not invented", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const input = classInput();
      const d = input.blocks[3];
      d.movements = d.movements.map((m) => (m.movement === "ab mat sit-up" ? { ...m, done_sets: undefined } : m));
      const { writer, calls } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, input)) as Record<string, any>;
      expect(r.not_logged).toEqual(["D) ab mat sit-up"]);
      expect(calls.workouts[0].exercises).toHaveLength(12);
      expect(calls.workouts[0].description).not.toContain("Sit Up: not counted");
    });
  });

  it("time window rules: explicit start_at wins; heart-rate stretch next; photo time last; nothing = ask", async () => {
    await inTest(async (ctx, tx) => {
      const { writer } = fakeWriter();
      const win = async (over: Partial<ClassInput>) => ((await logClassWorkout(ctx, writer, classInput({ photo_time: undefined, ...over }), { dry_run: true })) as any);

      await seedOuraClass(tx);
      expect((await win({ start_at: "2031-03-12T07:10:00-07:00", duration_min: 45 })).window).toMatchObject({ start_local: "2031-03-12 07:10", end_local: "07:55", minutes: 45, source: "explicit" });

      await tx`delete from oura_documents where collection = 'workout'`;
      const base = Date.parse("2031-03-12T14:05:00Z");
      for (let m = 0; m <= 50; m += 3) await tx`insert into hr_samples (ts, bpm, source) values (${new Date(base + m * 60_000)}, 130, 'oura:awake')`;
      const hr = await win({ photo_time: PHOTO });
      expect(hr.window).toMatchObject({ source: "heart_rate", start_local: "2031-03-12 07:05" });

      await tx`delete from hr_samples where ts between '2031-03-12' and '2031-03-13'`;
      const photo = await win({ photo_time: PHOTO });
      expect(photo.window).toMatchObject({ source: "photo_time", start_local: "2031-03-12 06:55", minutes: 50 });
      expect(photo.warnings.join(" ")).toMatch(/photo time/);

      await rejects(logClassWorkout(ctx, writer, classInput({ photo_time: undefined }), { dry_run: true }), /can't tell when the class was/);
      await rejects(logClassWorkout(ctx, writer, classInput({ photo_time: undefined, date: "2031-03-12" }), { dry_run: true }), /couldn't find the class in Oura/);
    });
  });

  it("class pull-ups are the UNASSISTED Pull Up by default; an explicit exercise_template_id beats the alias map (e.g. the assisted machine)", async () => {
    await inTest(async (ctx, tx) => {
      await seedOuraClass(tx);
      const { writer: w0 } = fakeWriter();
      const dflt = (await logClassWorkout(ctx, w0, classInput(), { dry_run: true })) as Record<string, any>;
      expect(dflt.blocks[0].exercises[1]).toMatchObject({ movement: "pull up", hevy_exercise: "Pull Up", matched_by: "alias_map" });
      const [pu] = await tx`select id from exercise_templates where title = 'Pull Up (Assisted)' and not is_custom`;
      const input = classInput();
      input.blocks[0].movements[1] = { ...input.blocks[0].movements[1], exercise_template_id: pu.id };
      const { writer } = fakeWriter();
      const r = (await logClassWorkout(ctx, writer, input, { dry_run: true })) as Record<string, any>;
      expect(r.blocks[0].exercises[1]).toMatchObject({ hevy_exercise: "Pull Up (Assisted)", matched_by: "explicit" });
      const bad = classInput();
      bad.blocks[0].movements[1] = { ...bad.blocks[0].movements[1], exercise_template_id: "NOPE" };
      await rejects(logClassWorkout(ctx, writer, bad, { dry_run: true }), /exercise_template_id "NOPE" doesn't exist/);
    });
  });
});
