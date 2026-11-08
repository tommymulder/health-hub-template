import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { seedLibrary } from "./helpers/library";
import { logClassWorkout } from "@/core/classes/log";
import { fallbackNote } from "@/core/classes/analysis";
import type { ClassInput } from "@/core/classes/types";
import { ToolError, type ToolCtx } from "@/core/tools/context";
import { fakeWriter } from "./helpers/fake-hevy";

// Phase 19 D against the real database (always rolled back) with a FAKE Hevy. Synthetic classes in March 2031.
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
      // Real classes and workouts exist now (his real bench history would make a synthetic class look like a PR or not): start clean INSIDE this rolled-back transaction.
      await tx`delete from class_sessions`; await tx`delete from workouts`;
      await fn({ sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") }, tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const upper = (date: string, setsDone: number, lb: number, over: Partial<ClassInput> = {}): ClassInput => ({
  gym: "Example Gym", class_type: "strength", title: "BUILD - Upper Body", start_at: `${date}T07:00:00-08:00`, duration_min: 50, board_text: "synthetic board", precision: "exact",
  blocks: [{ label: "A", format: "sets", sets: { min: 3, max: 4 }, sets_done: setsDone, movements: [{ movement: "barbell bench press", target: { reps: 8 }, weight: lb }] }],
  ...over,
});

describe.skipIf(!sql)("the dry run carries analysis (always rolled back, fake Hevy)", () => {
  it("completion, vs the last class of the same name, exercise comparisons, highlights and the note instructions", async () => {
    await inTest(async (ctx) => {
      const { writer } = fakeWriter();
      await logClassWorkout(ctx, writer, upper("2031-03-05", 3, 135)); // history: 24 of 32 reps = 75%
      const r: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145), { dry_run: true });
      expect(r.dry_run).toBe(true);
      const a = r.analysis;
      expect(a.class.completion).toMatchObject({ pct: 100, counted: "1 of 1 movements" });
      expect(a.class.vs_last_same_class).toMatchObject({ title: "BUILD - Upper Body", date: "2031-03-05", last_pct: 75, change_points: 25 });
      const bench = a.exercises.find((e: any) => e.exercise === "Bench Press (Barbell)");
      expect(bench).toMatchObject({ measure: "e1rm", verdict: "better", pr: { kind: "e1rm" } });
      expect(bench.last).toMatchObject({ date: "2031-03-05", where: "class" });
      expect(bench.line).toMatch(/Bench Press \(Barbell\): estimated max .* vs .* on 2031-03-05 \(\+.*%, PR\)/);
      expect(a.highlights.up.map((h: any) => h.exercise)).toEqual(["Bench Press (Barbell)"]);
      expect(a.highlights.down).toEqual([]);
      expect(a.class.type_trend.verdict).toBeNull(); // far fewer than 8 classes: numbers, no verdict
      expect(a.note_instructions).toMatch(/Did well[\s\S]*Work on[\s\S]*Trend[\s\S]*estimated/i);
      for (const e of ["📊", "✅", "🎯", "📈"]) expect(a.note_instructions).toContain(e);
      expect(a.note_instructions).toMatch(/blank line/i);
    });
  });

  it("a first time stays out of the highlights; an estimated comparison is IN them, labelled estimated", async () => {
    await inTest(async (ctx) => {
      const { writer } = fakeWriter();
      const first: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145), { dry_run: true });
      expect(first.analysis.exercises[0]).toMatchObject({ first_time: true });
      expect(first.analysis.highlights).toEqual({ up: [], down: [] });
      expect(first.analysis.class.vs_last_same_class).toMatchObject({ first_time: true });
      // an assumed (estimated) session on either side
      await logClassWorkout(ctx, writer, upper("2031-03-05", 3, 135, { completion_pct: 75, precision: "estimated", blocks: [{ label: "A", format: "sets", sets: { min: 3, max: 4 }, movements: [{ movement: "barbell bench press", target: { reps: 8 }, weight: 135 }] }] }));
      const est: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 150), { dry_run: true });
      expect(est.analysis.exercises[0].estimated).toBe(true);
      expect(est.analysis.highlights.up).toEqual([expect.objectContaining({ exercise: "Bench Press (Barbell)", estimated: true, verdict: "better" })]);
      expect(est.analysis.highlights.up[0].line).toMatch(/\(estimated\)$/);
      // and the fallback note says so too
      expect(fallbackNote(est.analysis)).toMatch(/✅ Did well\n• .*\(estimated\)/);
    });
  });
});

describe.skipIf(!sql)("the coaching note is the Hevy description and is saved with the class (always rolled back, fake Hevy)", () => {
  it("sends coaching_note as the Hevy description (never the station list) and stores it", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      const note = "Good session: 100% of the board, up from 75% last BUILD Upper.\nDid well: bench estimated max up.\nTo work on: +5 lb next time.";
      const r: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145, { coaching_note: note }));
      expect(r.logged).toBe(true);
      expect(calls.workouts[0].description).toBe(note);
      expect(calls.workouts[0].description).not.toMatch(/^A\n|Bench Press \(Barbell\): 8/);
      const [s] = await tx`select coaching_note from class_sessions where id = ${r.hub.class_session_id}`;
      expect(s.coaching_note).toBe(note);
      expect(r.analysis).toBeDefined(); // the real call recomputes the same analysis
    });
  });

  it("the dry run previews the note that would be sent", async () => {
    await inTest(async (ctx) => {
      const { writer, calls } = fakeWriter();
      const r: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145, { coaching_note: "A short note." }), { dry_run: true });
      expect(r.note).toEqual({ text: "A short note.", source: "coaching_note" });
      expect(calls.workouts).toHaveLength(0);
    });
  });

  it("a note over 1,500 characters is refused before anything is sent", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      const e = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145, { coaching_note: "x".repeat(1501) })).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toMatch(/coaching_note.*1,?500/);
      expect(calls.workouts).toHaveLength(0);
      expect(calls.templates).toHaveLength(0);
      expect((await tx`select count(*)::int as n from class_sessions where start_at >= '2031-01-01'`)[0].n).toBe(0);
    });
  });

  it("without a note the hub writes a short fallback from the analysis: completion line, no station list", async () => {
    await inTest(async (ctx, tx) => {
      const { writer, calls } = fakeWriter();
      await logClassWorkout(ctx, writer, upper("2031-03-05", 3, 135));
      const r: any = await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145));
      const d: string = calls.workouts[1].description!;
      expect(d).toMatch(/^📊 Board: 100% done/);
      expect(d).toMatch(/\n\n✅ Did well\n• /); // a blank line between sections, one bullet per line
      expect(d).toMatch(/up from 75%/);
      expect(d).toMatch(/Bench Press \(Barbell\):/); // an "up" line with numbers
      expect(d).not.toMatch(/^A\n/);
      expect(d.length).toBeLessThanOrEqual(1500);
      expect(r.note.source).toBe("fallback");
      const [s] = await tx`select coaching_note from class_sessions where id = ${r.hub.class_session_id}`;
      expect(s.coaching_note).toBe(d); // the fallback is stored too, so the hub and Hevy agree
    });
  });

  it("a first class with no history says 'first time logged' in the fallback", async () => {
    await inTest(async (ctx) => {
      const { writer, calls } = fakeWriter();
      await logClassWorkout(ctx, writer, upper("2031-03-12", 4, 145));
      expect(calls.workouts[0].description).toMatch(/first time logged/i);
    });
  });
});
