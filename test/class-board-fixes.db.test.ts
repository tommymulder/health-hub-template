import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { seedLibrary } from "./helpers/library";
import { applyBoardFixes, parseBoardFixes, reviewClasses, type BoardFixes } from "@/core/classes/boardFixes";
import { logClassWorkout } from "@/core/classes/log";
import type { ClassInput } from "@/core/classes/types";
import type { ToolCtx } from "@/core/tools/context";
import { getClassHistory } from "@/core/tools/classes";
import { fakeWriter } from "./helpers/fake-hevy";

// Phase 19 F against the real database (always rolled back) with a FAKE Hevy. A synthetic class in March 2031.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (ctx: ToolCtx, tx: Sql, sessionId: number) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await seedLibrary(tx);
      await tx`delete from settings where key like 'class_alias:%'`;
      await tx`delete from class_sessions`; await tx`delete from workouts`;
      const ctx: ToolCtx = { sql: tx, timezone: "America/Los_Angeles", units: "lb", hrMax: 190, now: () => new Date("2031-03-20T18:00:00Z") };
      // A class logged the OLD way: a for_time block with no posted rounds, and a cash-out split with a partner that reads as 25% done.
      const input: ClassInput = {
        gym: "Example Gym", class_type: "cardio_endurance", title: "FUEL - Cardio", start_at: "2031-03-12T07:00:00-07:00", duration_min: 50, board_text: "C) FOR TIME 3 ROUNDS: 10 WALL BALL / D) CASH OUT 40 PUSH UP SPLIT WITH PARTNER", precision: "exact",
        blocks: [
          { label: "C", format: "for_time", movements: [{ movement: "push up", target: { reps: 10 }, done_sets: [{ reps: 10 }, { reps: 10 }, { reps: 10 }] }] },
          { label: "D", format: "sets", sets: { min: 1, max: 1 }, sets_done: 1, movements: [{ movement: "push up", target: { reps: 40 }, done_sets: [{ reps: 10 }] }] },
        ],
      };
      const r: any = await logClassWorkout(ctx, fakeWriter().writer, input);
      await fn(ctx, tx, r.hub.class_session_id);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const fixes = (sessionId: number): BoardFixes => ({
  classes: [{ session_id: sessionId, blocks: [
    { label: "C", rounds: 3 },
    { label: "D", movements: [{ movement: "push up", total: true, share: 0.5 }] },
  ] }],
});

const snapshot = async (tx: Sql, id: number) => ({
  session: (await tx`select gym, class_type, title, board_text, precision, completion_pct, user_notes, hevy_workout_id, coaching_note, planned from class_sessions where id = ${id}`)[0],
  blocks: await tx`select label, format, sets_min, sets_max, interval_s, rounds, time_cap_s, sets_done from class_blocks where session_id = ${id} order by label`,
  movements: await tx`select b.label, m.position, m.movement, m.exercise_template_id, m.target, m.variant_done, m.done_sets, m.assumed from class_movements m join class_blocks b on b.id = m.block_id where b.session_id = ${id} order by b.label, m.position`,
});

describe("parseBoardFixes: only the named fields are accepted", () => {
  it("accepts rounds, total, share and optional", () => {
    expect(parseBoardFixes({ classes: [{ session_id: 1, blocks: [{ label: "C", rounds: 3, movements: [{ movement: "x", total: true, share: 0.5, optional: false }] }] }] })).toBeDefined();
  });
  it("accepts a missed movement to add, per-side done reps, and an exclusion", () => {
    const ok = parseBoardFixes({ classes: [{ session_id: 1, exclude_from_completion: "board reconstructed from memory", blocks: [{ label: "A", add_movements: [{ movement: "thruster", target: { reps: 80, total: true, share: 0.5, note: "cash out" } }], movements: [{ movement: "row", done_reps: [16, 16] }] }] }] });
    expect(ok.classes[0].exclude_from_completion).toBe("board reconstructed from memory");
    expect(ok.classes[0].blocks[0].add_movements?.[0].target).toEqual({ reps: 80, total: true, share: 0.5, note: "cash out" });
    expect(ok.classes[0].blocks[0].movements?.[0].done_reps).toEqual([16, 16]);
  });
  it("refuses a bad addition, bad done reps and an empty exclusion", () => {
    const bad = (o: unknown) => expect(() => parseBoardFixes(o)).toThrow();
    const blk = (b: object) => ({ classes: [{ session_id: 1, blocks: [{ label: "A", ...b }] }] });
    bad(blk({ add_movements: [{ movement: "x" }] })); // needs a target
    bad(blk({ add_movements: [{ movement: "x", target: { done_sets: [] } }] })); // only board fields
    bad(blk({ add_movements: [{ movement: "x", target: { reps: 5 }, done_sets: [{ reps: 5 }] }] })); // an added movement is always zero done
    bad(blk({ add_movements: [{ movement: "x", target: { reps: 5, share: 2 } }] }));
    bad(blk({ movements: [{ movement: "x", done_reps: [] }] }));
    bad(blk({ movements: [{ movement: "x", done_reps: [1.5] }] }));
    bad(blk({ movements: [{ movement: "x", done_reps: [0] }] }));
    bad({ classes: [{ session_id: 1, exclude_from_completion: "", blocks: [] }] });
    bad({ classes: [{ session_id: 1, exclude_from_completion: 5, blocks: [] }] });
  });
  it("refuses any other field, a bad share, bad rounds and unknown shapes", () => {
    const bad = (o: unknown) => expect(() => parseBoardFixes(o)).toThrow();
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", movements: [{ movement: "x", reps: 5 }] }] }] }); // reps is not one of the four
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", movements: [{ movement: "x", done_sets: [] }] }] }] });
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", movements: [{ movement: "x", share: 0 }] }] }] });
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", movements: [{ movement: "x", share: 1.5 }] }] }] });
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", rounds: 0 }] }] });
    bad({ classes: [{ session_id: 1, board_text: "new text", blocks: [] }] });
    bad({ classes: "nope" });
    bad({ classes: [{ session_id: 1, blocks: [{ label: "C", note: "x" }] }] });
  });
});

describe.skipIf(!sql)("class board fixes (always rolled back, fake Hevy)", () => {
  it("the review lists what isn't countable and why", async () => {
    await inTest(async (ctx, tx, id) => {
      const r = await reviewClasses(tx);
      const c = r.find((x) => x.session_id === id)!;
      expect(c.title).toBe("FUEL - Cardio");
      expect(c.not_counted.find((n) => n.block === "C")?.reason).toMatch(/no posted rounds/i);
      expect(c.blocks_without_rounds).toEqual(["C"]);
      expect(c.board_mentions.join(" ")).toMatch(/split with partner/i);
      expect(c.completion_pct).toBe(25); // block D: 10 of 40, as if he had done it alone
    });
  });

  it("a DRY RUN changes nothing but says what it would change", async () => {
    await inTest(async (_ctx, tx, id) => {
      const before = await snapshot(tx, id);
      const r = await applyBoardFixes(tx, fixes(id), { apply: false });
      expect(r).toMatchObject({ applied: false, changes: { blocks: 1, movements: 1, planned: 1 } });
      expect(r.details.join(" ")).toMatch(/rounds/);
      expect(r.completion).toEqual([expect.objectContaining({ session_id: id, before: 25, after: 75, counted_before: "1 of 2 movements", counted_after: "2 of 2 movements" })]);
      expect(await snapshot(tx, id)).toEqual(before);
    });
  });

  it("--apply changes only rounds, total, share and optional, and the class then counts correctly", async () => {
    await inTest(async (_ctx, tx, id) => {
      const before = await snapshot(tx, id);
      const r = await applyBoardFixes(tx, fixes(id), { apply: true });
      expect(r).toMatchObject({ applied: true, changes: { blocks: 1, movements: 1, planned: 1 } });
      const after = await snapshot(tx, id);
      // everything else is byte-for-byte what it was
      expect({ ...after.session, planned: undefined }).toEqual({ ...before.session, planned: undefined });
      expect(after.blocks.map((b) => ({ ...b, rounds: undefined }))).toEqual(before.blocks.map((b) => ({ ...b, rounds: undefined })));
      expect(after.blocks.find((b) => b.label === "C")!.rounds).toBe(3);
      expect(after.movements.map((m) => ({ ...m, target: undefined }))).toEqual(before.movements.map((m) => ({ ...m, target: undefined })));
      const dTarget = after.movements.find((m) => m.label === "D")!.target as Record<string, unknown>;
      expect(dTarget).toEqual({ reps: 40, total: true, share: 0.5 }); // the original keys are kept
      expect(after.movements.find((m) => m.label === "C")!.target).toEqual(before.movements.find((m) => m.label === "C")!.target);
      // the stored `planned` copy is updated to match
      const planned = after.session.planned as any;
      expect(planned.blocks.find((b: any) => b.label === "C").rounds).toBe(3);
      expect(planned.blocks.find((b: any) => b.label === "D").movements[0].target).toMatchObject({ total: true, share: 0.5 });
      const c = (await reviewClasses(tx)).find((x) => x.session_id === id)!;
      expect(c.completion_pct).toBe(Math.round(((30 / 30 + 10 / 20) / 2) * 1000) / 10); // C: 30 of 30 reps; D: 10 of 20 (half of 40)
      expect(c.blocks_without_rounds).toEqual([]);
    });
  });

  it("a second --apply changes 0 rows", async () => {
    await inTest(async (_ctx, tx, id) => {
      await applyBoardFixes(tx, fixes(id), { apply: true });
      const again = await applyBoardFixes(tx, fixes(id), { apply: true });
      expect(again.changes).toEqual({ blocks: 0, movements: 0, planned: 0, added: 0, done_edits: 0, excluded: 0 });
    });
  });

  it("an unknown class, block or movement stops everything: nothing is applied", async () => {
    await inTest(async (_ctx, tx, id) => {
      const before = await snapshot(tx, id);
      await expect(applyBoardFixes(tx, { classes: [{ session_id: id, blocks: [{ label: "C", rounds: 3 }, { label: "Z", rounds: 2 }] }] }, { apply: true })).rejects.toThrow(/block Z/);
      await expect(applyBoardFixes(tx, { classes: [{ session_id: id, blocks: [{ label: "D", movements: [{ movement: "squat", share: 0.5 }] }] }] }, { apply: true })).rejects.toThrow(/squat/);
      await expect(applyBoardFixes(tx, { classes: [{ session_id: 999999999, blocks: [] }] }, { apply: true })).rejects.toThrow(/class 999999999/);
      expect(await snapshot(tx, id)).toEqual(before);
    });
  });

  it("optional: false removes nothing it should keep; optional: true is stored", async () => {
    await inTest(async (_ctx, tx, id) => {
      await applyBoardFixes(tx, { classes: [{ session_id: id, blocks: [{ label: "D", movements: [{ movement: "push up", optional: true }] }] }] }, { apply: true });
      expect((await snapshot(tx, id)).movements.find((m) => m.label === "D")!.target).toEqual({ reps: 40, optional: true });
    });
  });

  const addFix = (id: number): BoardFixes => ({ classes: [{ session_id: id, blocks: [
    { label: "C", rounds: 3 },
    { label: "D", movements: [{ movement: "push up", total: true, share: 0.5 }], add_movements: [{ movement: "burpee", target: { reps: 20, total: true, share: 0.5, note: "cash out, skipped" } }] },
  ] }] });

  it("adds a missed movement with ZERO done (hub only), and it counts as 0% of its posted work", async () => {
    await inTest(async (_ctx, tx, id) => {
      const r = await applyBoardFixes(tx, addFix(id), { apply: true });
      expect(r.changes.added).toBe(1);
      const m = (await snapshot(tx, id)).movements.filter((x) => x.label === "D");
      expect(m.map((x) => x.movement)).toEqual(["push up", "burpee"]);
      expect(m[1]).toMatchObject({ position: 1, exercise_template_id: null, assumed: false, done_sets: [], target: { reps: 20, total: true, share: 0.5, note: "cash out, skipped" } });
      expect(((await snapshot(tx, id)).session.planned as any).blocks.find((b: any) => b.label === "D").movements.map((x: any) => x.movement)).toEqual(["push up", "burpee"]);
      const c = (await reviewClasses(tx)).find((x) => x.session_id === id)!;
      expect(c.completion_pct).toBe(62.5); // C 100; D = (push up 10 of 20 = 50, burpee 0 of 10 = 0) -> 25
      expect(c.counted).toBe("3 of 3 movements");
    });
  });
  it("the dry run shows the addition in the before -> after table and writes nothing", async () => {
    await inTest(async (_ctx, tx, id) => {
      const before = await snapshot(tx, id);
      const r = await applyBoardFixes(tx, addFix(id), { apply: false });
      expect(r.changes.added).toBe(1);
      expect(r.completion[0]).toMatchObject({ before: 25, after: 62.5, counted_after: "3 of 3 movements" });
      expect(await snapshot(tx, id)).toEqual(before);
    });
  });
  it("adding twice adds once", async () => {
    await inTest(async (_ctx, tx, id) => {
      await applyBoardFixes(tx, addFix(id), { apply: true });
      expect((await applyBoardFixes(tx, addFix(id), { apply: true })).changes).toEqual({ blocks: 0, movements: 0, planned: 0, added: 0, done_edits: 0, excluded: 0 });
    });
  });

  describe("per-side done reps", () => {
    const withRow = async (tx: Sql, id: number) => {
      const [b] = await tx`select id from class_blocks where session_id = ${id} and label = 'C'`;
      await tx`insert into class_movements (block_id, position, movement, target, done_sets) values (${b.id}, 9, 'dumbbell single arm row', ${tx.json({ reps: 8, per_side: true } as never)}, ${tx.json([{ reps: 8, weight_kg: 18.1 }, { reps: 8, weight_kg: 18.1 }] as never)})`;
    };
    const fix = (id: number, done_reps: number[]): BoardFixes => ({ classes: [{ session_id: id, blocks: [{ label: "C", movements: [{ movement: "dumbbell single arm row", done_reps }] }] }] });
    const rowDone = async (tx: Sql, id: number) => (await snapshot(tx, id)).movements.find((m) => m.movement === "dumbbell single arm row")!.done_sets;
    it("doubles the stored reps and keeps every other field of each set", async () => {
      await inTest(async (_ctx, tx, id) => {
        await withRow(tx, id);
        const r = await applyBoardFixes(tx, fix(id, [16, 16]), { apply: true });
        expect(r.changes.done_edits).toBe(1);
        expect(await rowDone(tx, id)).toEqual([{ reps: 16, weight_kg: 18.1 }, { reps: 16, weight_kg: 18.1 }]);
      });
    });
    it("a second apply changes 0 rows (it can never double twice)", async () => {
      await inTest(async (_ctx, tx, id) => {
        await withRow(tx, id);
        await applyBoardFixes(tx, fix(id, [16, 16]), { apply: true });
        expect((await applyBoardFixes(tx, fix(id, [16, 16]), { apply: true })).changes.done_edits).toBe(0);
        expect(await rowDone(tx, id)).toEqual([{ reps: 16, weight_kg: 18.1 }, { reps: 16, weight_kg: 18.1 }]);
      });
    });
    it("refuses anything that is not exactly double (or already double), and a wrong set count", async () => {
      await inTest(async (_ctx, tx, id) => {
        await withRow(tx, id);
        await expect(applyBoardFixes(tx, fix(id, [17, 16]), { apply: true })).rejects.toThrow(/double/i);
        await expect(applyBoardFixes(tx, fix(id, [16]), { apply: true })).rejects.toThrow(/2 sets/);
        expect(await rowDone(tx, id)).toEqual([{ reps: 8, weight_kg: 18.1 }, { reps: 8, weight_kg: 18.1 }]);
      });
    });
    it("a dry run changes nothing", async () => {
      await inTest(async (_ctx, tx, id) => {
        await withRow(tx, id);
        const r = await applyBoardFixes(tx, fix(id, [16, 16]), { apply: false });
        expect(r.changes.done_edits).toBe(1);
        expect(await rowDone(tx, id)).toEqual([{ reps: 8, weight_kg: 18.1 }, { reps: 8, weight_kg: 18.1 }]);
      });
    });
  });

  describe("exclude a class from completion", () => {
    const ex = (id: number): BoardFixes => ({ classes: [{ session_id: id, exclude_from_completion: "board reconstructed from memory", blocks: [] }] });
    it("stores the reason; the class then has no completion and is left out of every average, with the reason shown", async () => {
      await inTest(async (ctx, tx, id) => {
        expect((await applyBoardFixes(tx, ex(id), { apply: true })).changes.excluded).toBe(1);
        const [row] = await tx`select completion_excluded from class_sessions where id = ${id}`;
        expect(row.completion_excluded).toBe("board reconstructed from memory");
        const c = (await reviewClasses(tx)).find((x) => x.session_id === id)!;
        expect(c.completion_pct).toBeNull();
        const h: any = await getClassHistory(ctx, { days: 60 });
        const s = h.classes.find((x: any) => x.session_id === id);
        expect(s.completion).toMatchObject({ pct: null, excluded: "board reconstructed from memory" });
        expect(h.completion_trend.by_type.find((t: any) => t.class_type === "cardio_endurance")).toBeUndefined(); // no countable class of that type left
      });
    });
    it("the dry run changes nothing; a second apply changes 0 rows", async () => {
      await inTest(async (_ctx, tx, id) => {
        expect((await applyBoardFixes(tx, ex(id), { apply: false })).completion[0]).toMatchObject({ before: 25, after: null });
        expect((await tx`select completion_excluded from class_sessions where id = ${id}`)[0].completion_excluded).toBeNull();
        await applyBoardFixes(tx, ex(id), { apply: true });
        expect((await applyBoardFixes(tx, ex(id), { apply: true })).changes.excluded).toBe(0);
      });
    });
  });
});
