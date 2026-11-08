import { describe, it, expect, afterAll } from "vitest";
import fixture from "./fixtures/class-boards/example-board-expected.json";
import { createSql, type Sql } from "@/core/db";
import { upsertWorkout } from "@/core/hevy/sync";
import { seedLibrary } from "./helpers/library";
import { logClassWorkout } from "@/core/classes/log";
import type { BlockInput, ClassInput } from "@/core/classes/types";
import type { HevyWriteApi } from "@/core/hevy/write";
import type { ToolCtx } from "@/core/tools/context";
import { getClassHistory } from "@/core/tools/classes";
import { getExerciseProgress } from "@/core/tools/progress";
import { getTrainingSummary } from "@/core/tools/summary";
import { getRecentWorkouts, getWorkoutDetails } from "@/core/tools/workouts";

// A class logged through the REAL flow (fake Hevy, rolled-back DB), then read back through every read tool.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (ctx: ToolCtx, tx: Sql, log: (over?: Partial<ClassInput>) => Promise<unknown>) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await seedLibrary(tx);
      // A custom 'Hollow Hold' or remembered matches may already exist in a real database: start clean INSIDE this always-rolled-back transaction.
      await tx`delete from exercise_templates where title = 'Hollow Hold'`;
      await tx`delete from settings where key like 'class_alias:%'`;
      const ctx: ToolCtx = { sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") };
      const writer = fakeWriter();
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('workout', 'ow1', '2031-03-12', '2031-03-12T14:02:00Z', '2031-03-12T15:00:00Z', ${tx.json({ activity: "fitnessClass" })})`;
      // heart rate during the class: 100 samples, 130 bpm
      for (let m = 0; m < 58; m += 1) await tx`insert into hr_samples (ts, bpm, source) values (${new Date(Date.parse("2031-03-12T14:02:00Z") + m * 60_000)}, 130, 'oura:awake')`;
      await fn(ctx, tx, (over = {}) => logClassWorkout(ctx, writer, input(over)));
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

function fakeWriter(): HevyWriteApi {
  let n = 0;
  return {
    listRoutineFolders: async () => [], getRoutine: async () => ({}), createRoutineFolder: async () => { throw new Error("x"); }, createRoutine: async () => { throw new Error("x"); }, updateRoutine: async () => { throw new Error("x"); },
    createExerciseTemplate: async () => ({ raw: { id: `CUST${++n}` } }),
    createWorkout: async (b) => ({ raw: { workout: [{ id: "hw-read", title: b.title, description: b.description, start_time: b.start_time, end_time: b.end_time, updated_at: b.end_time, created_at: b.end_time,
      exercises: b.exercises.map((e, i) => ({ index: i, title: e.exercise_template_id, exercise_template_id: e.exercise_template_id, superset_id: e.superset_id, notes: e.notes, sets: e.sets.map((s, j) => ({ index: j, ...s })) })) }] } }),
  } as HevyWriteApi;
}

const board = fixture.blocks as unknown as BlockInput[];
const done: Record<string, number> = { A: 4, B: 3, C: 3, D: 3 };
const wt: Record<string, number | number[]> = { "barbell strict press": [75, 85, 95, 105], "pull up": 40, "dumbbell bicep curl": 25, "barbell bench press": [135, 155, 165, 175], "barbell pendlay row": 115,
  "cable crunch": 60, "dumbbell chest press": 40, "dumbbell single arm row": 55, "dumbbell overhead tricep extension": 30 };
const input = (over: Partial<ClassInput> = {}): ClassInput => ({
  gym: "Example Gym", class_type: "strength", photo_time: "2031-03-12T06:55:00-07:00", board_text: fixture.board_text, precision: "partial",
  blocks: board.map((b) => ({ ...b, sets_done: done[b.label], movements: b.movements.map((m) => ({ ...m, weight: wt[m.movement],
    ...(m.movement === "ab mat sit-up" ? { done_sets: [{ reps: 20 }, { reps: 18 }, { reps: 16 }] } : {}),
    ...(m.movement === "hollow hold" ? { create_custom: { exercise_type: "duration", muscle_group: "abdominals" } } : {}) })) })) as BlockInput[],
  ...over,
});

describe.skipIf(!sql)("classes through the read tools (fake Hevy, rolled-back DB)", () => {
  it("get_recent_workouts: the class appears ONCE, as a class; its Hevy copy is not listed again as a lifting session", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      expect(Number((await tx`select count(*) as n from workouts where id = 'hw-read'`)[0].n)).toBe(1); // the Hevy copy exists in the hub...
      const r = (await getRecentWorkouts(ctx, { start: "2031-03-12", end: "2031-03-12" })) as Record<string, any>;
      expect(r.count).toBe(1); // ...but is shown once
      expect(r.workouts).toHaveLength(1);
      expect(r.workouts[0]).toMatchObject({ kind: "class", title: "Example Gym — Strength", class_type: "strength", date: "2031-03-12", time: "07:02", duration_min: 58, precision: "partial", hevy_workout_id: "hw-read" });
      expect(r.workouts[0].heart_rate).toMatchObject({ avg: 130, max: 130 });
      expect(r.workouts[0].working_sets).toBe(42); // A 4 sets x 3 movements + B 3x3 + C 3x3 + D 3 rounds x 4 movements = 12 + 9 + 9 + 12
    });
  });

  it("get_training_summary: classes are sessions by kind with minutes and heart rate; their sets still count once in the muscle totals", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      const r = (await getTrainingSummary(ctx, { start: "2031-03-10", end: "2031-03-16" })) as Record<string, any>;
      expect(r.sessions_by_kind).toEqual({ lifting: 0, strength: 1 }); // NOT lifting: 1 as well
      expect(r.classes).toMatchObject({ count: 1, minutes: 58, avg_heart_rate: 130 });
      expect(r.weeks[0]).toMatchObject({ sessions: 0, classes: { count: 1, minutes: 58, by_type: { strength: 1 } } });
      expect(r.totals.hard_sets).toBe(42);
      expect(r.totals.hard_sets_by_muscle.chest).toBeGreaterThan(0); // bench + dumbbell press sets were counted via the Hevy copy
    });
  });

  it("get_training_summary: also counts classes Oura detected that were never logged (but not the one that WAS logged)", async () => {
    await inTest(async (ctx, tx, log) => {
      // a second Oura-detected class two days later, never logged
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('workout', 'ow2', '2031-03-14', '2031-03-14T14:00:00Z', '2031-03-14T15:00:00Z', ${tx.json({ activity: "fitnessClass" })})`;
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('workout', 'ow3', '2031-03-15', '2031-03-15T16:00:00Z', '2031-03-15T16:40:00Z', ${tx.json({ activity: "walking" })})`;
      const before = (await getTrainingSummary(ctx, { start: "2031-03-10", end: "2031-03-16" })) as Record<string, any>;
      expect(before.classes).toMatchObject({ count: 0, oura_detected_not_logged: { count: 2, minutes: 118, dates: ["2031-03-12", "2031-03-14"] }, total_including_oura_detected: 2 });
      expect(before.weeks[0].oura_detected_classes_not_logged).toBe(2); // a walk is not a class

      await log(); // logging the Mar 12 class: its Oura detection now IS that class
      const after = (await getTrainingSummary(ctx, { start: "2031-03-10", end: "2031-03-16" })) as Record<string, any>;
      expect(after.classes).toMatchObject({ count: 1, oura_detected_not_logged: { count: 1, minutes: 60, dates: ["2031-03-14"] }, total_including_oura_detected: 2 });
      expect(after.sessions_by_kind).toEqual({ lifting: 0, strength: 1 }); // unchanged: unlogged classes have no sets
    });
  });

  it("get_exercise_progress: the class bench is on the SAME trend as gym bench, labelled where: class", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      const r = (await getExerciseProgress(ctx, { exercise: "79D0BB3A", since: "2031-01-01" })) as Record<string, any>;
      expect(r.exercise.title).toBe("Bench Press (Barbell)");
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]).toMatchObject({ date: "2031-03-12", where: "class", working_sets: 3, top_set: { weight: 165, reps: 4 } });
      // A gym workout with the same exercise (seeded here: a fresh hub has no history) lands on the SAME trend.
      await upsertWorkout(tx, {
        id: "gym-bench", title: "Gym", routine_id: null, description: null, start_time: "2031-02-02T17:00:00Z", end_time: "2031-02-02T17:45:00Z",
        updated_at: "2031-02-02T17:45:00Z", created_at: "2031-02-02T17:45:00Z",
        exercises: [{ index: 0, title: "Bench Press (Barbell)", notes: null, exercise_template_id: "79D0BB3A", superset_id: null,
          sets: [{ index: 0, type: "normal", weight_kg: 80, reps: 5, distance_meters: null, duration_seconds: null, rpe: null, custom_metric: null }] }],
      }, "America/Los_Angeles");
      const older = (await getExerciseProgress(ctx, { exercise: "79D0BB3A", since: "2025-01-01" })) as Record<string, any>;
      expect(older.sessions.some((s: any) => s.where === "gym")).toBe(true);
      expect(older.sessions.some((s: any) => s.where === "class")).toBe(true);
    });
  });

  it("get_workout_details on the Hevy copy says it is a class", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      const r = (await getWorkoutDetails(ctx, { workout_id: "hw-read" })) as Record<string, any>;
      expect(r.class).toMatchObject({ class_type: "strength", precision: "partial" });
    });
  });

  it("get_class_history: planned vs done, per movement, in the user's units", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      const r = (await getClassHistory(ctx, { days: 30 })) as Record<string, any>;
      expect(r.count).toBe(1);
      const c = r.classes[0];
      expect(c).toMatchObject({ date: "2031-03-12", class_type: "strength", time_source: "oura_workout" });
      expect(c.blocks.map((b: any) => [b.block, b.sets_done])).toEqual([["A", 4], ["B", 3], ["C", 3], ["D", 3]]);
      const press = c.blocks[0].movements[0];
      expect(press.board_target).toEqual({ reps_by_set: [8, 6, 4, 2] });
      expect(press.done).toEqual([{ reps: 8, weight: 75 }, { reps: 6, weight: 85 }, { reps: 4, weight: 95 }, { reps: 2, weight: 105 }]);
    });
  });

  it("get_class_history with a movement: only that movement, plus its history; explains an empty result", async () => {
    await inTest(async (ctx, tx, log) => {
      await log();
      const r = (await getClassHistory(ctx, { movement: "v-up", days: 30 })) as Record<string, any>;
      expect(r.movement_history).toEqual([expect.objectContaining({ date: "2031-03-12", movement: "v up", total_reps: 45 })]); // stored normalised; 15 x 3 rounds (low end of 15-20)
      expect(r.classes[0].blocks).toHaveLength(1);
      expect(r.classes[0].blocks[0].movements).toHaveLength(1);
      await expect(getClassHistory(ctx, { movement: "turkish get up", days: 30 })).rejects.toThrow(/No logged class/);
      await expect(getClassHistory(ctx, { class_type: "cardio_endurance", days: 30 })).rejects.toThrow(/No classes are logged/);
    });
  });

  it("hub-only classes (log_to_hevy:false) still show up in history and recent workouts", async () => {
    await inTest(async (ctx, tx, log) => {
      await log({ log_to_hevy: false, blocks: input().blocks.map((b) => ({ ...b, movements: b.movements.map(({ create_custom, ...m }) => m) })) });
      const r = (await getRecentWorkouts(ctx, { start: "2031-03-12", end: "2031-03-12" })) as Record<string, any>;
      expect(r.workouts).toHaveLength(1);
      expect(r.workouts[0]).toMatchObject({ kind: "class" });
      expect(r.workouts[0].hevy_workout_id).toBeUndefined();
    });
  });
});
