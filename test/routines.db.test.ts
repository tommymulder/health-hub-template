import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { HevyWriteError, type HevyWriteApi, type RoutineBody } from "@/core/hevy/write";
import { ToolError, type ToolCtx } from "@/core/tools/context";
import { createRoutine, prepareRoutine, updateRoutine, type RoutineInput } from "@/core/tools/routines";
import { lbToKg } from "@/core/units";

// Real database, ALWAYS rolled back; the Hevy writer is a fake, so NOTHING here
// can touch Hevy. Skipped when no DATABASE_URL exists.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
type Calls = { listFolders: number; createFolder: string[]; createRoutine: RoutineBody[]; updateRoutine: { id: string; body: RoutineBody }[]; getRoutine: string[] };

function fakeWriter(folders: { id: number; title: string }[] = [], over: Partial<HevyWriteApi> = {}) {
  const calls: Calls = { listFolders: 0, createFolder: [], createRoutine: [], updateRoutine: [], getRoutine: [] };
  let n = 0;
  const writer: HevyWriteApi = {
    listRoutineFolders: async () => { calls.listFolders++; return [...folders]; },
    getRoutine: async (id) => { calls.getRoutine.push(id); return { routine: { id, title: "OLD VERSION" } }; },
    createRoutineFolder: async (t) => { calls.createFolder.push(t); folders.push({ id: 99, title: t }); return { raw: { id: 99, title: t } }; },
    createRoutine: async (b) => { calls.createRoutine.push(b); return { raw: { routine: { id: `hevy-${++n}`, title: b.title } } }; },
    updateRoutine: async (id, b) => { calls.updateRoutine.push({ id, body: b }); return { raw: { routine: { id } } }; },
    createWorkout: async () => { throw new Error("not used in routine tests"); },
    createExerciseTemplate: async () => { throw new Error("not used in routine tests"); },
    ...over,
  };
  return { writer, calls };
}

async function inTest(fn: (ctx: (u?: "lb" | "kg") => ToolCtx, tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`delete from settings where key = 'hevy_claude_folder_id'`;
      await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at) values
        ('TESTSQ01', 'Zztest Squat (Barbell)', 'weight_reps', 'quadriceps', '[]'::jsonb, 'barbell', false, now()),
        ('TESTPL01', 'Zztest Plank', 'duration', 'abdominals', '[]'::jsonb, 'none', false, now()),
        ('TESTPU01', 'Zztest Push Up', 'reps_only', 'chest', '[]'::jsonb, 'none', false, now()),
        ('TESTDI01', 'Zztest Run', 'distance_duration', 'cardio', '[]'::jsonb, 'none', false, now())`;
      await fn((units = "lb") => ({ sql: tx, timezone: "America/Los_Angeles", units }), tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const routine = (title = "Zztest Heavy Lower", over: Partial<RoutineInput> = {}): RoutineInput => ({
  title,
  notes: "Designed by Claude",
  exercises: [
    { exercise_template_id: "TESTSQ01", rest_seconds: 180, sets: [{ type: "warmup", weight: 135, reps: 5 }, { type: "normal", weight: 225, reps: 3 }] },
    { exercise_template_id: "TESTPL01", sets: [{ duration_s: 60 }] },
  ],
  ...over,
});
const audit = (tx: Sql, title: string) =>
  tx`select kind, action, outcome, hevy_id, request, response, previous from hevy_writes where title = ${title} order by id`;
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ToolError);
  expect((e as Error).message).toMatch(re);
};

describe.skipIf(!sql)("routine tools (fake Hevy, rolled-back DB)", () => {
  it("converts lb to kg at FULL precision so 225 lb comes back as 225", async () => {
    await inTest(async (ctx) => {
      const p = await prepareRoutine(ctx(), routine());
      expect(p.body.exercises[0].sets[1].weight_kg).toBe(lbToKg(225)); // exactly, no rounding
      expect(p.body.exercises[0].sets[1].weight_kg).toBeCloseTo(102.05828325, 8);
      expect(p.preview.exercises[0].sets[1]).toMatchObject({ weight: 225, reps: 3, type: "normal" });
      expect(p.preview.exercises[0].sets[0]).toMatchObject({ weight: 135 });
      expect(p.body.exercises[1].sets[0]).toEqual({ type: "normal", weight_kg: null, reps: null, duration_seconds: 60 });
      expect(p.body.exercises[0].rest_seconds).toBe(180);
      const kg = await prepareRoutine(ctx("kg"), routine());
      expect(kg.body.exercises[0].sets[1].weight_kg).toBe(225); // kg users pass through untouched
    });
  });

  it("reports EVERY problem at once, with closest ids, and sends nothing", async () => {
    await inTest(async (ctx) => {
      const bad: RoutineInput = {
        title: "  ",
        exercises: [
          { exercise_template_id: "TESTSQ02", sets: [{ weight: 100, reps: 5 }] }, // not a real id (one character off)
          { exercise_template_id: "TESTPL01", sets: [{ reps: 10 }] }, // timed exercise without a duration
          { exercise_template_id: "TESTSQ01", rest_seconds: 9999, sets: [{ weight: -5, reps: 0 }, { type: "bogus", weight: 100000, reps: 5 }] },
          { exercise_template_id: "TESTDI01", sets: [{ reps: 1 }] }, // a type this tool can't build
        ],
      };
      const err = await prepareRoutine(ctx(), bad).then(() => null, (e) => e as Error);
      expect(err).toBeInstanceOf(ToolError);
      const m = err!.message;
      expect(m).toMatch(/nothing was sent/);
      expect(m).toMatch(/title is required/);
      expect(m).toMatch(/TESTSQ02" doesn't exist.*TESTSQ01 = Zztest Squat/);
      expect(m).toMatch(/Plank is timed/);
      expect(m).toMatch(/rest_seconds/);
      expect(m).toMatch(/weight must be 0 or more/);
      expect(m).toMatch(/reps must be a whole number/);
      expect(m).toMatch(/type must be one of/);
      expect(m).toMatch(/typo/);
      expect(m).toMatch(/distance_duration.*can't build/);
    });
  });

  it("warns (doesn't fail) about missing weights and ignored weights", async () => {
    await inTest(async (ctx) => {
      const p = await prepareRoutine(ctx(), { title: "Zztest W", exercises: [
        { exercise_template_id: "TESTSQ01", sets: [{ reps: 5 }] },
        { exercise_template_id: "TESTPU01", sets: [{ reps: 10, weight: 25 }] },
      ] });
      expect(p.warnings.join(" ")).toMatch(/no weight/);
      expect(p.warnings.join(" ")).toMatch(/reps only/);
    });
  });

  it("dry_run previews without touching Hevy or the audit log", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      const r = await createRoutine(ctx(), writer, routine(), { dry_run: true });
      expect(r).toMatchObject({ dry_run: true });
      expect(calls).toEqual({ listFolders: 0, createFolder: [], createRoutine: [], updateRoutine: [], getRoutine: [] });
      expect(await audit(tx, "Zztest Heavy Lower")).toHaveLength(0);
    });
  });

  it("creates the Claude folder once, posts kg into it, and audits everything", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      const r = await createRoutine(ctx(), writer, routine());
      expect(r).toMatchObject({ created: true, routine_id: "hevy-1", folder: "Claude" });
      expect(calls.createFolder).toEqual(["Claude"]);
      expect(calls.createRoutine).toHaveLength(1);
      expect(calls.createRoutine[0]).toMatchObject({ title: "Zztest Heavy Lower", folder_id: 99, notes: "Designed by Claude" });
      expect(calls.createRoutine[0].exercises[0].sets[1].weight_kg).toBe(lbToKg(225));

      const [row] = await audit(tx, "Zztest Heavy Lower");
      expect(row).toMatchObject({ kind: "routine", action: "create", outcome: "ok", hevy_id: "hevy-1" });
      expect((row.request as RoutineBody).folder_id).toBe(99); // the audit holds the exact payload sent
      // (a real "Claude" folder row now exists in the database, so find THIS test's row by its fake id)
      const [folder] = await tx`select kind, outcome, hevy_id from hevy_writes where title = 'Claude' and hevy_id = '99'`;
      expect(folder).toMatchObject({ kind: "routine_folder", outcome: "ok", hevy_id: "99" });
      const [setting] = await tx`select value from settings where key = 'hevy_claude_folder_id'`;
      expect(setting.value).toBe("99");
    });
  });

  it("reads the folder id from the REAL reply shape {routine_folder: {id}} (spec says flat; live API wraps it)", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter([], {
        createRoutineFolder: async (t) => ({ raw: { routine_folder: { id: 3846446, index: 0, title: t } } }),
      });
      await createRoutine(ctx(), writer, routine());
      expect(calls.createRoutine[0].folder_id).toBe(3846446);
      const [setting] = await tx`select value from settings where key = 'hevy_claude_folder_id'`;
      expect(setting.value).toBe("3846446");
    });
  });

  it("reuses an existing Claude folder, and caches it so later calls skip the lookup", async () => {
    await inTest(async (ctx) => {
      const { writer, calls } = fakeWriter([{ id: 5, title: "Push" }, { id: 7, title: "Claude" }]);
      await createRoutine(ctx(), writer, routine("Zztest A"));
      await createRoutine(ctx(), writer, routine("Zztest B"));
      expect(calls.createFolder).toEqual([]);
      expect(calls.listFolders).toBe(1); // second call used the cached id
      expect(calls.createRoutine.map((b) => b.folder_id)).toEqual([7, 7]);
    });
  });

  it("DOUBLE-SUBMIT GUARD: the same title within 10 minutes is not sent twice", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      const first = await createRoutine(ctx(), writer, routine());
      const second = await createRoutine(ctx(), writer, routine());
      expect(calls.createRoutine).toHaveLength(1);
      expect(second).toMatchObject({ already_created: true, routine_id: (first as { routine_id: string }).routine_id });

      await createRoutine(ctx(), writer, routine("Zztest Different Title"));
      expect(calls.createRoutine).toHaveLength(2); // other titles are unaffected

      await tx`update hevy_writes set created_at = now() - interval '11 minutes' where title = 'Zztest Heavy Lower'`;
      await createRoutine(ctx(), writer, routine());
      expect(calls.createRoutine).toHaveLength(3); // after the window, a re-use of the title is allowed
    });
  });

  it("a crash mid-flight (pending row left behind) still blocks a blind retry", async () => {
    await inTest(async (ctx, tx) => {
      await tx`insert into hevy_writes (hevy_id, kind, action, outcome, title, request) values ('pending:x', 'routine', 'create', 'pending', 'Zztest Crash', '{}'::jsonb)`;
      const { writer, calls } = fakeWriter();
      const r = await createRoutine(ctx(), writer, routine("Zztest Crash"));
      expect(r).toMatchObject({ already_created: true });
      expect(JSON.stringify(r)).toMatch(/unconfirmed/);
      expect(calls.createRoutine).toHaveLength(0);
    });
  });

  it("a definite refusal (400/403) is recorded as rejected and may be retried at once", async () => {
    await inTest(async (ctx, tx) => {
      let refuse = true;
      const { writer, calls } = fakeWriter([{ id: 7, title: "Claude" }], {
        createRoutine: async (b) => {
          calls.createRoutine.push(b);
          if (refuse) throw new HevyWriteError("Hevy refused (403): Routine limit exceeded. This usually means the routine limit was reached.", 403, false);
          return { raw: { routine: { id: "hevy-ok" } } };
        },
      });
      await rejects(createRoutine(ctx(), writer, routine()), /limit.*Nothing was created in Hevy/s);
      expect((await audit(tx, "Zztest Heavy Lower"))[0]).toMatchObject({ outcome: "rejected" });
      refuse = false;
      expect(await createRoutine(ctx(), writer, routine())).toMatchObject({ created: true, routine_id: "hevy-ok" });
      expect(calls.createRoutine).toHaveLength(2);
    });
  });

  it("an unconfirmed result (no reply) says so, and blocks the retry that could duplicate it", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter([{ id: 7, title: "Claude" }], {
        createRoutine: async (b) => { calls.createRoutine.push(b); throw new HevyWriteError("No response from Hevy (ECONNRESET)", undefined, true); },
      });
      await rejects(createRoutine(ctx(), writer, routine()), /may or may not have been created.*check/si);
      expect((await audit(tx, "Zztest Heavy Lower"))[0]).toMatchObject({ outcome: "unconfirmed" });
      const retry = await createRoutine(ctx(), writer, routine());
      expect(retry).toMatchObject({ already_created: true });
      expect(calls.createRoutine).toHaveLength(1); // the retry never reached Hevy
    });
  });

  it("if the Claude folder can't be prepared, the routine is NOT sent and the audit says rejected", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter([], { listRoutineFolders: async () => { throw new HevyWriteError("No response from Hevy (down)"); } });
      await rejects(createRoutine(ctx(), writer, routine()), /folder/);
      expect(calls.createRoutine).toHaveLength(0);
      expect((await audit(tx, "Zztest Heavy Lower"))[0]).toMatchObject({ outcome: "rejected" });
    });
  });

  it("copes with an unexpected reply: created, id unknown, raw reply kept, warning shown", async () => {
    await inTest(async (ctx, tx) => {
      const { writer } = fakeWriter([{ id: 7, title: "Claude" }], { createRoutine: async () => ({ raw: { ok: true } }) });
      const r = (await createRoutine(ctx(), writer, routine())) as { created: boolean; routine_id: string | null; warnings: string[] };
      expect(r).toMatchObject({ created: true, routine_id: null });
      expect(r.warnings.join(" ")).toMatch(/no id/);
      const [row] = await audit(tx, "Zztest Heavy Lower");
      expect(row.outcome).toBe("ok");
      expect(String(row.hevy_id)).toMatch(/^unknown:/);
      expect(row.response).toEqual({ ok: true });
    });
  });

  it("also accepts a reply shaped {routine: [ {id} ]}", async () => {
    await inTest(async (ctx) => {
      const { writer } = fakeWriter([{ id: 7, title: "Claude" }], { createRoutine: async () => ({ raw: { routine: [{ id: "arr-1" }] } }) });
      expect(await createRoutine(ctx(), writer, routine())).toMatchObject({ routine_id: "arr-1" });
    });
  });

  it("update: only routines the hub created, keeps a copy of the old one, always keeps the Claude folder", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter([{ id: 7, title: "Claude" }]);
      await rejects(updateRoutine(ctx(), writer, { ...routine(), routine_id: "someone-elses" }), /only update routines I created/);
      expect(calls.getRoutine).toHaveLength(0);
      expect(calls.updateRoutine).toHaveLength(0);

      const created = (await createRoutine(ctx(), writer, routine())) as { routine_id: string };
      const edited = routine("Zztest Heavy Lower v2", { exercises: [{ exercise_template_id: "TESTSQ01", sets: [{ weight: 230, reps: 3 }] }] });
      const dry = await updateRoutine(ctx(), writer, { ...edited, routine_id: created.routine_id }, { dry_run: true });
      expect(dry).toMatchObject({ dry_run: true });
      expect(calls.updateRoutine).toHaveLength(0);

      const r = await updateRoutine(ctx(), writer, { ...edited, routine_id: created.routine_id });
      expect(r).toMatchObject({ updated: true });
      expect(calls.updateRoutine).toHaveLength(1);
      expect(calls.updateRoutine[0].body).toMatchObject({ title: "Zztest Heavy Lower v2", folder_id: 7 });
      expect(calls.updateRoutine[0].body.exercises[0].sets[0].weight_kg).toBe(lbToKg(230));

      const [row] = await audit(tx, "Zztest Heavy Lower v2");
      expect(row).toMatchObject({ action: "update", outcome: "ok", hevy_id: created.routine_id });
      expect(row.previous).toEqual({ routine: { id: created.routine_id, title: "OLD VERSION" } });
    });
  });

  it("update: never overwrites if the old version can't be read, and handles 'routine is gone'", async () => {
    await inTest(async (ctx, tx) => {
      const base = fakeWriter([{ id: 7, title: "Claude" }]);
      const created = (await createRoutine(ctx(), base.writer, routine())) as { routine_id: string };

      const unreadable = fakeWriter([{ id: 7, title: "Claude" }], { getRoutine: async () => { throw new HevyWriteError("No response from Hevy (down)"); } });
      await rejects(updateRoutine(ctx(), unreadable.writer, { ...routine("Zztest X"), routine_id: created.routine_id }), /did not overwrite/);
      expect(unreadable.calls.updateRoutine).toHaveLength(0);

      const gone = fakeWriter([{ id: 7, title: "Claude" }], { updateRoutine: async () => { throw new HevyWriteError("Hevy says that routine doesn't exist (it may have been deleted in the app).", 404, false); } });
      await rejects(updateRoutine(ctx(), gone.writer, { ...routine("Zztest Y"), routine_id: created.routine_id }), /deleted.*Nothing was changed/s);
      expect((await audit(tx, "Zztest Y"))[0]).toMatchObject({ action: "update", outcome: "rejected" });
    });
  });
});
