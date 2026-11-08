import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { logPress, ordinal } from "@/core/events/log";
import type { ToolCtx } from "@/core/tools/context";

// Synthetic data only; every test is rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try { await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const ctxAt = (tx: Sql, iso: string): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date(iso) });
const clear = async (tx: Sql) => { await tx`delete from events`; await tx`delete from oura_documents`; };

describe("ordinal", () => {
  it.each([[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [103, "103rd"]])("%i -> %s", (n, s) => expect(ordinal(n)).toBe(s));
});

describe.skipIf(!sql)("logPress (always rolled back)", () => {
  it("the hub stamps the time, and the reply counts this night's presses ('2nd tonight')", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      // 2031-05-02 09:14Z = 02:14 PDT: the night with no ring data uses the fallback window (20:00 -> 08:00)
      const first = await logPress(ctxAt(tx, "2031-05-02T08:00:00Z"), { type: "bathroom", source: "shortcut" });
      expect(first.message).toBe("Trip logged 1:00 AM (1st tonight)");
      const second = await logPress(ctxAt(tx, "2031-05-02T09:14:00Z"), { type: "bathroom", source: "shortcut" });
      expect(second).toMatchObject({ duplicate: false, message: "Trip logged 2:14 AM (2nd tonight)" });
      expect(second.id).toBeGreaterThan(first.id);
      const rows = await tx`select type, source, approximate, at from events order by id`;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ type: "bathroom", source: "shortcut", approximate: false });
      expect(rows[1].at.toISOString()).toBe("2031-05-02T09:14:00.000Z");
    });
  });

  it("a second press within 60 seconds returns the first and saves nothing; at 61 seconds it counts", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const a = await logPress(ctxAt(tx, "2031-05-02T09:14:00Z"), { type: "bathroom", source: "shortcut" });
      const b = await logPress(ctxAt(tx, "2031-05-02T09:14:30Z"), { type: "bathroom", source: "shortcut" });
      expect(b).toMatchObject({ id: a.id, duplicate: true });
      expect(b.message).toMatch(/^Already logged 2:14 AM \(1st tonight\)/);
      expect((await tx`select count(*)::int as n from events`)[0].n).toBe(1);
      const c = await logPress(ctxAt(tx, "2031-05-02T09:15:01Z"), { type: "bathroom", source: "shortcut" });
      expect(c.duplicate).toBe(false);
      expect((await tx`select count(*)::int as n from events`)[0].n).toBe(2);
    });
  });

  it("a hidden press does not block a new one, and daytime presses say 'today'", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const a = await logPress(ctxAt(tx, "2031-05-02T20:00:00Z"), { type: "bathroom", source: "shortcut" }); // 13:00 PDT
      expect(a.message).toBe("Trip logged 1:00 PM (1st today)");
      await tx`update events set hidden = true where id = ${a.id}`;
      const b = await logPress(ctxAt(tx, "2031-05-02T20:00:20Z"), { type: "bathroom", source: "shortcut" });
      expect(b.duplicate).toBe(false);
      expect(b.message).toBe("Trip logged 1:00 PM (1st today)"); // the hidden one is not counted
    });
  });

  it("with the ring's night stored, the window is bedtime - 60 min to wake time, and a later press is a day trip", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('sleep', 'n1', '2031-05-02', '2031-05-02T06:40:00Z', '2031-05-02T14:10:00Z',
        ${tx.json({ type: "long_sleep", total_sleep_duration: 26000, sleep_phase_5_min: "2222" } as never)})`;
      const night = await logPress(ctxAt(tx, "2031-05-02T13:30:00Z"), { type: "bathroom", source: "shortcut" }); // 06:30 PDT, before the 07:10 wake time
      expect(night.message).toBe("Trip logged 6:30 AM (1st tonight)");
      const morning = await logPress(ctxAt(tx, "2031-05-02T14:40:00Z"), { type: "bathroom", source: "shortcut" }); // 07:40 PDT: up for the day
      expect(morning.message).toBe("Trip logged 7:40 AM (1st today)");
    });
  });

  it("refuses an unknown type", async () => {
    await inRollback(async (tx) => {
      await expect(logPress(ctxAt(tx, "2031-05-02T09:14:00Z"), { type: "coffee", source: "shortcut" })).rejects.toThrow(/type/);
    });
  });
});

import { logEvent } from "@/core/events/log";

describe.skipIf(!sql)("log_event: Claude logs a remembered trip, or hides/restores a mis-press (always rolled back)", () => {
  const NOW = "2031-05-02T18:00:00Z"; // 11:00 PDT on 2031-05-02
  const ctx = (tx: Sql) => ctxAt(tx, NOW);

  it("saves a remembered time as approximate with source 'claude', resolving 'HH:MM' with the night it belongs to", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const r: any = await logEvent(ctx(tx), { type: "bathroom", at: "03:10", night: "2031-05-02", note: "woke up thirsty" });
      expect(r).toMatchObject({ saved: true });
      expect(r.message).toMatch(/3:10 AM/);
      const [row] = await tx`select at, source, approximate, note, hidden from events where id = ${r.id}`;
      expect(row.at.toISOString()).toBe("2031-05-02T10:10:00.000Z");
      expect(row).toMatchObject({ source: "claude", approximate: true, note: "woke up thirsty", hidden: false });
      // an evening time on that night belongs to the evening BEFORE the wake-up date
      const e: any = await logEvent(ctx(tx), { type: "bathroom", at: "23:30", night: "2031-05-02" });
      expect((await tx`select at from events where id = ${e.id}`)[0].at.toISOString()).toBe("2031-05-02T06:30:00.000Z"); // 23:30 PDT May 1
    });
  });

  it("without a night, 'HH:MM' means the most recent such time in the past; a full date-time with no offset is Pacific", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const early: any = await logEvent(ctx(tx), { type: "bathroom", at: "03:10" }); // already passed today
      expect((await tx`select at from events where id = ${early.id}`)[0].at.toISOString()).toBe("2031-05-02T10:10:00.000Z");
      const late: any = await logEvent(ctx(tx), { type: "bathroom", at: "23:30" }); // not yet today: last night
      expect((await tx`select at from events where id = ${late.id}`)[0].at.toISOString()).toBe("2031-05-02T06:30:00.000Z");
      const iso: any = await logEvent(ctx(tx), { type: "bathroom", at: "2031-05-01T12:30" });
      expect((await tx`select at from events where id = ${iso.id}`)[0].at.toISOString()).toBe("2031-05-01T19:30:00.000Z");
      const z: any = await logEvent(ctx(tx), { type: "bathroom", at: "2031-05-02T05:00:00Z" });
      expect((await tx`select at from events where id = ${z.id}`)[0].at.toISOString()).toBe("2031-05-02T05:00:00.000Z");
    });
  });

  it("refuses the future, more than 48 hours back, nonsense, and mixing modes; saves nothing", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "2031-05-02T15:00" })).rejects.toThrow(/future/);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "2031-04-30T10:00" })).rejects.toThrow(/48 hours/);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "sometime" })).rejects.toThrow(/time/);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "25:99" })).rejects.toThrow(/time/);
      await expect(logEvent(ctx(tx), { type: "bathroom" })).rejects.toThrow(/at|hide_id|restore_id/);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "03:10", hide_id: 1 })).rejects.toThrow(/one of/);
      await expect(logEvent(ctx(tx), { type: "coffee", at: "03:10" })).rejects.toThrow(/type/);
      await expect(logEvent(ctx(tx), { type: "bathroom", at: "03:10", note: "x".repeat(201) })).rejects.toThrow(/200/);
      expect((await tx`select count(*)::int as n from events`)[0].n).toBe(0);
    });
  });

  it("hides a mis-press (reversible, never deleted) and restores it; an unknown id is refused", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const a = await logPress(ctxAt(tx, "2031-05-02T09:14:00Z"), { type: "bathroom", source: "shortcut" });
      const h: any = await logEvent(ctx(tx), { type: "bathroom", hide_id: a.id });
      expect(h).toMatchObject({ hidden: true, id: a.id });
      expect((await tx`select hidden from events where id = ${a.id}`)[0].hidden).toBe(true);
      expect((await tx`select count(*)::int as n from events`)[0].n).toBe(1); // never deleted
      const r: any = await logEvent(ctx(tx), { type: "bathroom", restore_id: a.id });
      expect(r).toMatchObject({ hidden: false, id: a.id });
      expect((await tx`select hidden from events where id = ${a.id}`)[0].hidden).toBe(false);
      await expect(logEvent(ctx(tx), { type: "bathroom", hide_id: 999999999 })).rejects.toThrow(/No bathroom event/);
    });
  });

  it("mentions a press that is already logged within 10 minutes of the time (a forgotten-press fix may be a duplicate)", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logPress(ctxAt(tx, "2031-05-02T10:12:00Z"), { type: "bathroom", source: "shortcut" }); // 03:12 PDT
      const r: any = await logEvent(ctx(tx), { type: "bathroom", at: "03:10" });
      expect(r.already_logged_nearby).toHaveLength(1);
      expect(r.saved).toBe(true);
    });
  });
});
