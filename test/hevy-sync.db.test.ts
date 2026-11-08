import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { syncHevyTemplates, syncHevyWorkouts, upsertWorkout, type SyncDeps } from "@/core/hevy/sync";
import type { HevyApi, HevyEvent, HevyTemplate, HevyWorkout, Page } from "@/core/hevy/types";
import fixture from "./fixtures/hevy/workout.json";

// These tests talk to the REAL database, but every test runs inside a
// transaction that is ALWAYS rolled back (inRollback), so nothing persists and
// real rows are never touched. They skip themselves if no DATABASE_URL exists.
try { process.loadEnvFile(".env.local"); } catch { /* no local env file */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const NOW = new Date("2026-10-11T12:00:00Z");
const base = fixture as unknown as HevyWorkout;
const wk = (id: string, over: Partial<HevyWorkout> = {}): HevyWorkout => ({ ...base, id, ...over });

function paged<T>(items: T[], page: number, size: number): Page<T> {
  return { page, page_count: Math.max(1, Math.ceil(items.length / size)), items: items.slice((page - 1) * size, page * size) };
}
function fakeHevy(workouts: HevyWorkout[], events: HevyEvent[] = [], templates: HevyTemplate[] = []): HevyApi & { since: string[] } {
  const since: string[] = [];
  return {
    since,
    getWorkoutsPage: async (p) => paged(workouts, p, 2),
    getEventsPage: async (s, p) => { since.push(s); return paged(events, p, 2); },
    getTemplatesPage: async (p) => paged(templates, p, 2),
    getWorkoutCount: async () => workouts.length,
  };
}
const deps = (tx: Sql, hevy: HevyApi, budgetMs = 60_000): SyncDeps =>
  ({ sql: tx, hevy, timezone: "America/Los_Angeles", now: () => NOW, budgetMs });

const resetState = (tx: Sql) =>
  tx`delete from sync_state where source in ('hevy_workouts','hevy_backfill','hevy_templates')`;
const counts = async (tx: Sql, like: string) => {
  const [r] = await tx<{ w: string; e: string; s: string }[]>`
    select (select count(*) from workouts where id like ${like}) as w,
           (select count(*) from workout_exercises where workout_id like ${like}) as e,
           (select count(*) from sets s join workout_exercises e on e.id = s.workout_exercise_id where e.workout_id like ${like}) as s`;
  return { workouts: Number(r.w), exercises: Number(r.e), sets: Number(r.s) };
};

describe.skipIf(!sql)("Hevy sync against Postgres (always rolled back)", () => {
  it("upsert is idempotent: same workout twice changes nothing", async () => {
    await inRollback(async (tx) => {
      await upsertWorkout(tx, wk("test-idem"), "America/Los_Angeles");
      const once = await counts(tx, "test-idem");
      await upsertWorkout(tx, wk("test-idem"), "America/Los_Angeles");
      expect(await counts(tx, "test-idem")).toEqual(once);
      expect(once).toEqual({ workouts: 1, exercises: 2, sets: 3 });
      const [row] = await tx`select local_date::text as d, raw->>'title' as t from workouts where id = 'test-idem'`;
      expect(row).toEqual({ d: "2026-11-01", t: "Heavy Lower" });
    });
  });

  it("an updated workout replaces its exercises and sets (no orphans)", async () => {
    await inRollback(async (tx) => {
      await upsertWorkout(tx, wk("test-upd"), "America/Los_Angeles");
      await upsertWorkout(tx, wk("test-upd", { title: "Edited", exercises: [base.exercises[0]] }), "America/Los_Angeles");
      expect(await counts(tx, "test-upd")).toEqual({ workouts: 1, exercises: 1, sets: 2 });
      const [row] = await tx`select title from workouts where id = 'test-upd'`;
      expect(row.title).toBe("Edited");
    });
  });

  it("backfill is resumable: stops at the time budget, then continues where it left off", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      const all = ["test-bf1", "test-bf2", "test-bf3", "test-bf4", "test-bf5"].map((id) => wk(id));
      const hevy = fakeHevy(all);

      const first = await syncHevyWorkouts(deps(tx, hevy, 0)); // zero budget: one page, then stop
      expect(first).toMatchObject({ ok: true, mode: "backfill", complete: false, workoutsUpserted: 2 });
      expect((await counts(tx, "test-bf%")).workouts).toBe(2);
      const [mid] = await tx`select cursor from sync_state where source = 'hevy_backfill'`;
      expect(mid.cursor).toBe("2");

      const second = await syncHevyWorkouts(deps(tx, hevy));
      expect(second).toMatchObject({ ok: true, mode: "backfill", complete: true });
      expect((await counts(tx, "test-bf%")).workouts).toBe(5);
      const [done] = await tx`select cursor from sync_state where source = 'hevy_backfill'`;
      expect(done.cursor).toBe("done");

      const third = await syncHevyWorkouts(deps(tx, hevy));
      expect(third.mode).toBe("incremental");
      expect((await counts(tx, "test-bf%")).workouts).toBe(5); // nothing duplicated
    });
  });

  it("incremental applies updates and deletes, and the cursor is the run START time", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      await tx`insert into sync_state (source, cursor) values ('hevy_backfill','done'), ('hevy_workouts','2026-10-01T00:00:00.000Z')`;
      await upsertWorkout(tx, wk("test-inc1"), "America/Los_Angeles");
      await upsertWorkout(tx, wk("test-inc2"), "America/Los_Angeles");
      const events: HevyEvent[] = [
        { type: "updated", workout: wk("test-inc1", { title: "Renamed", updated_at: "2026-10-05T00:00:00Z" }) },
        { type: "deleted", id: "test-inc2", deleted_at: "2026-10-05T00:00:00Z" },
      ];
      const hevy = fakeHevy([], events);
      const res = await syncHevyWorkouts(deps(tx, hevy));
      expect(res).toMatchObject({ ok: true, mode: "incremental", workoutsUpserted: 1, workoutsDeleted: 1 });
      expect(hevy.since[0]).toBe("2026-10-01T00:00:00.000Z"); // asked for events since the old cursor
      const rows = await tx`select id, title, deleted from workouts where id like 'test-inc%' order by id`;
      expect(rows.map((r) => [r.id, r.title, r.deleted])).toEqual([
        ["test-inc1", "Renamed", false],
        ["test-inc2", "Heavy Lower", true],
      ]);
      const [c] = await tx`select cursor, last_error from sync_state where source = 'hevy_workouts'`;
      expect(c.cursor).toBe(NOW.toISOString());
      expect(c.last_error).toBeNull();
    });
  });

  it("an older update never resurrects a deleted workout, whatever the event order", async () => {
    for (const order of ["deleted-first", "updated-first"] as const) {
      await inRollback(async (tx) => {
        await resetState(tx);
        await tx`insert into sync_state (source, cursor) values ('hevy_backfill','done'), ('hevy_workouts','2026-10-01T00:00:00.000Z')`;
        await upsertWorkout(tx, wk("test-res"), "America/Los_Angeles"); // we already hold an older copy
        const upd: HevyEvent = { type: "updated", workout: wk("test-res", { updated_at: "2026-10-05T09:00:00Z" }) };
        const del: HevyEvent = { type: "deleted", id: "test-res", deleted_at: "2026-10-05T10:00:00Z" };
        await syncHevyWorkouts(deps(tx, fakeHevy([], order === "deleted-first" ? [del, upd] : [upd, del])));
        const [row] = await tx`select deleted from workouts where id = 'test-res'`;
        expect(row.deleted).toBe(true);
      });
    }
  });

  it("a failing Hevy call is recorded in sync_state and never thrown", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      const broken: HevyApi = { ...fakeHevy([]), getWorkoutsPage: async () => { throw new Error("Hevy GET /v1/workouts failed: 401"); } };
      const res = await syncHevyWorkouts(deps(tx, broken));
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining("401") });
      const [row] = await tx`select last_error from sync_state where source = 'hevy_workouts'`;
      expect(row.last_error).toContain("401");
    });
  });

  it("sync applies the CSV-import time correction from settings, and only to the listed batch", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      await tx`insert into settings (key, value) values ('hevy_local_time_batches', ${JSON.stringify(["IMPORT-BATCH"])})
               on conflict (key) do update set value = excluded.value`;
      const early = { start_time: "2026-03-30T05:30:00Z", end_time: "2026-03-30T06:20:00Z" };
      const hevy = fakeHevy([wk("test-imp", { ...early, created_at: "IMPORT-BATCH" }), wk("test-nat", { ...early, created_at: "native" })]);
      await syncHevyWorkouts(deps(tx, hevy));
      const rows = await tx`select id, to_char(start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as utc, local_date::text as d,
                                   raw->>'start_time' as raw_start from workouts where id in ('test-imp','test-nat') order by id`;
      expect(rows.map((r) => [r.id, r.utc, r.d])).toEqual([
        ["test-imp", "2026-03-30T12:30", "2026-03-30"], // corrected
        ["test-nat", "2026-03-30T05:30", "2026-03-29"], // untouched
      ]);
      expect(rows[0].raw_start).toBe("2026-03-30T05:30:00Z"); // original preserved in raw
    });
  });

  it("the TypeScript conversion agrees with Postgres's own AT TIME ZONE", async () => {
    const { wallClockToInstant } = await import("@/core/time");
    const samples = ["2026-10-10T17:17:43Z", "2026-01-15T07:00:00Z", "2026-03-30T05:30:00Z", "2025-02-07T11:53:00Z",
      "2026-03-07T23:59:59Z", "2026-03-08T12:00:00Z", "2026-11-01T12:00:00Z", "2026-10-31T23:30:00Z"];
    for (const iso of samples) {
      const [r] = await sql!`select (((${iso}::timestamptz) at time zone 'UTC') at time zone 'America/Los_Angeles') as t`;
      expect(wallClockToInstant(iso, "America/Los_Angeles").getTime(), iso).toBe((r.t as Date).getTime());
    }
  });

  it("template sync is idempotent", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      const t = (n: number): HevyTemplate => ({
        id: `test-tpl-${n}`, title: `Lift ${n}`, type: "weight_reps", primary_muscle_group: "quadriceps",
        secondary_muscle_groups: ["glutes"], equipment: "barbell", is_custom: false,
      });
      const hevy = fakeHevy([], [], [t(1), t(2), t(3)]);
      const a = await syncHevyTemplates(deps(tx, hevy));
      const b = await syncHevyTemplates(deps(tx, hevy));
      expect(a).toMatchObject({ ok: true, templatesUpserted: 3 });
      expect(b.ok).toBe(true);
      const [r] = await tx`select count(*) as n, bool_and(secondary_muscles = '["glutes"]'::jsonb) as ok from exercise_templates where id like 'test-tpl-%'`;
      expect(Number(r.n)).toBe(3);
      expect(r.ok).toBe(true);
    });
  });

  it("template sync prunes templates Hevy no longer returns, but never on a small listing", async () => {
    await inRollback(async (tx) => {
      await resetState(tx);
      // Work on a clean table inside the rolled-back transaction so the real rows can't skew the 50% guard.
      await tx`delete from exercise_templates`;
      const t = (n: number): HevyTemplate => ({
        id: `test-tpl-${n}`, title: `Lift ${n}`, type: "weight_reps", primary_muscle_group: "quadriceps",
        secondary_muscle_groups: [], equipment: "barbell", is_custom: n > 2,
      });
      await syncHevyTemplates(deps(tx, fakeHevy([], [], [t(1), t(2), t(3), t(4)])));
      const ids = async () => (await tx<{ id: string }[]>`select id from exercise_templates order by id`).map((r) => r.id);
      expect(await ids()).toEqual(["test-tpl-1", "test-tpl-2", "test-tpl-3", "test-tpl-4"]);

      // Hevy now lists 3 of the 4 (a custom exercise was deleted): the missing one goes.
      const a = await syncHevyTemplates(deps(tx, fakeHevy([], [], [t(1), t(2), t(3)])));
      expect(a).toMatchObject({ ok: true, templatesPruned: 1 });
      expect(await ids()).toEqual(["test-tpl-1", "test-tpl-2", "test-tpl-3"]);

      // A listing under half of what we hold (or empty) is treated as suspect: nothing is deleted.
      const b = await syncHevyTemplates(deps(tx, fakeHevy([], [], [t(1)])));
      expect(b).toMatchObject({ ok: true, templatesPruned: 0 });
      const c = await syncHevyTemplates(deps(tx, fakeHevy([], [], [])));
      expect(c).toMatchObject({ ok: true, templatesPruned: 0 });
      expect(await ids()).toEqual(["test-tpl-1", "test-tpl-2", "test-tpl-3"]);
    });
  });
});
