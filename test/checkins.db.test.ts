import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { logCheckin, saveShortcutCheckin } from "@/core/checkins/log";
import { getCheckins, getFeelVsRing } from "@/core/checkins/read";
import { getRecovery } from "@/core/tools/recovery";
import { localDateTime } from "@/core/time";
import { ToolError, type ToolCtx } from "@/core/tools/context";

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

const ctxAt = (tx: Sql, iso: string): ToolCtx => ({
  sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date(iso),
});

describe.skipIf(!sql)("morning check-ins (always rolled back)", () => {
  it("replaces a same-day rating, and 11:30pm and 12:30am are different Pacific days", async () => {
    await inRollback(async (tx) => {
      const late = ctxAt(tx, "2026-10-15T06:30:00Z"); // 11:30pm Oct 14
      const first = await saveShortcutCheckin(late, { rating: 4, note: "first" });
      expect(first).toMatchObject({ day: "2026-10-14", rating: 4, recalled: false, source: "shortcut" });
      expect(first.message).toBe("Saved 4/5 (Good) for Wed Oct 14");
      expect(first.replaced).toBeNull();
      const replaced = await saveShortcutCheckin(late, { rating: 2, note: null });
      expect(replaced.rating).toBe(2);
      expect(replaced.replaced).toEqual({ rating: 4, label: "Good", source: "shortcut" });
      expect(replaced.message).toBe("Saved 2/5 (Rough) for Wed Oct 14, replacing 4/5 (Good)");
      const rows = await tx<{ rating: number; note: string | null }[]>`
        select rating, note from morning_checkins where day = '2026-10-14'`;
      expect(rows).toEqual([{ rating: 2, note: null }]);

      const early = ctxAt(tx, "2026-10-15T07:30:00Z"); // 12:30am Oct 15
      const next = await saveShortcutCheckin(early, { rating: 5, note: "awake" });
      expect(next.day).toBe("2026-10-15");
      expect((await tx`select count(*)::int as n from morning_checkins where day in ('2026-10-14', '2026-10-15')`)[0].n).toBe(2);
    });
  });

  it("get_recovery shows today's rating, and null before it is rated", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxAt(tx, "2099-10-10T17:00:00Z"); // 10:00am Pacific Oct 10; getRecovery needs one stored Oura day, so seed one
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values ('daily_readiness', 'chk-rec', '2099-10-10', null, null, ${tx.json({ score: 80 } as never)})`;
      expect((await getRecovery(ctx, { days: 1 })).morning_checkin).toBeNull();
      await saveShortcutCheckin(ctx, { rating: 3, note: null });
      expect((await getRecovery(ctx, { days: 1 })).morning_checkin).toMatchObject({ day: "2099-10-10", rating: 3, label: "OK", recalled: false, source: "shortcut" });
    });
  });

  it("a recalled rating from Claude says which rating it replaced", async () => {
    await inRollback(async (tx) => {
      await saveShortcutCheckin(ctxAt(tx, "2026-10-17T15:00:00Z"), { rating: 4, note: null }); // 8am Oct 17
      const later = await logCheckin(ctxAt(tx, "2026-10-18T17:00:00Z"), { rating: 2, date: "2026-10-17" });
      expect(later).toMatchObject({ recalled: true, replaced: { rating: 4, label: "Good", source: "shortcut" } });
      expect(later.message).toMatch(/replacing 4\/5 \(Good\)$/);
    });
  });

  it("leaves mornings with no main sleep out of the analysis, and says how many", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxAt(tx, "2026-12-01T17:00:00Z"); // no Oura data this far ahead
      await logCheckin(ctx, { rating: 2 });
      await logCheckin(ctx, { rating: 5, date: "2026-11-30" });
      const felt = await getFeelVsRing(ctx, { days: 7 });
      expect(felt.left_out_no_main_sleep).toBe(2);
      expect(felt.rated_mornings).toBe(0);
      const listed = await getCheckins(ctx, { days: 7 });
      expect(listed.days).toHaveLength(2); // the ratings are kept, just not analysed
    });
  });

  it("stores yesterday as recalled, and refuses a date more than 2 days back", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxAt(tx, "2026-10-18T17:00:00Z"); // 10:00am Pacific Oct 18
      const yesterday = await logCheckin(ctx, { rating: 3, note: "I felt a 3 yesterday", date: "2026-10-17" });
      expect(yesterday).toMatchObject({ day: "2026-10-17", rating: 3, recalled: true, source: "claude" });
      const twoBack = await logCheckin(ctx, { rating: "1", date: "2026-10-16" });
      expect(twoBack.recalled).toBe(true);
      const today = await logCheckin(ctx, { rating: 4 });
      expect(today).toMatchObject({ day: "2026-10-18", recalled: false });
      await expect(logCheckin(ctx, { rating: 3, date: "2026-10-15" })).rejects.toThrow(/2 days/);
      await expect(logCheckin(ctx, { rating: 3, date: "2026-10-19" })).rejects.toThrow(ToolError);
      const stored = await tx<{ day: string; recalled: boolean }[]>`
        select day::text as day, recalled from morning_checkins where day between '2026-10-16' and '2026-10-18' order by day`;
      expect(stored).toEqual([
        { day: "2026-10-16", recalled: true },
        { day: "2026-10-17", recalled: true },
        { day: "2026-10-18", recalled: false },
      ]);
    });
  });

  it("matches the longest long_sleep and ignores a nap filed on the same day", async () => {
    await inRollback(async (tx) => {
      const day = "2099-06-02";
      const wake = "2099-06-02T14:45:00Z"; // 7:45am Pacific
      const napEnd = "2099-06-02T02:00:00Z"; // previous evening, wrongly usable if naps counted
      await tx`insert into oura_documents (collection, id, day, start_at, end_at, data) values
        ('sleep', 'chk-nap', ${day}, '2099-06-02T01:00:00Z', ${napEnd}, ${tx.json({ type: "sleep", total_sleep_duration: 3600, average_hrv: 99, score: 1 } as never)}),
        ('sleep', 'chk-short', ${day}, '2099-06-02T12:00:00Z', '2099-06-02T14:00:00Z', ${tx.json({ type: "long_sleep", total_sleep_duration: 7200, average_hrv: 11 } as never)}),
        ('sleep', 'chk-long', ${day}, '2099-06-02T06:40:00Z', ${wake}, ${tx.json({ type: "long_sleep", total_sleep_duration: 28800, average_hrv: 40, lowest_heart_rate: 52, deep_sleep_duration: 5400, rem_sleep_duration: 7200, efficiency: 91, latency: 600 } as never)}),
        ('daily_sleep', 'chk-score', ${day}, null, null, ${tx.json({ score: 78 } as never)}),
        ('daily_readiness', 'chk-ready', ${day}, null, null, ${tx.json({ score: 80, temperature_deviation: -0.2 } as never)}),
        ('daily_activity', 'chk-steps', '2099-06-01', null, null, ${tx.json({ steps: 8400 } as never)}),
        ('workout', 'chk-class', '2099-06-01', '2099-06-01T14:00:00Z', '2099-06-01T15:00:00Z', ${tx.json({ activity: "fitnessClass", start_datetime: "2099-06-01T14:00:00Z", end_datetime: "2099-06-01T15:00:00Z" } as never)}),
        ('enhanced_tag', 'chk-tag', '2099-06-01', null, null, ${tx.json({ custom_name: "sauna", tag_type_code: "sauna" } as never)})`;
      const ctx = ctxAt(tx, "2099-06-02T16:45:00Z"); // exactly 2 hours after the long sleep's wake
      await logCheckin(ctx, { rating: 4, date: day });
      const got = await getCheckins(ctx, { days: 7 });
      const row = got.days.find((d) => d.day === day) as {
        hours_after_waking: number; sleep: { wake_local: string; bedtime_local: string; avg_hrv_ms: number; score: number; temperature_deviation_c: number };
        readiness: number; previous_day: { steps: number; classes: number; class_minutes: number; tags: string[] };
      };
      expect(row.hours_after_waking).toBe(2);
      expect(row.sleep.wake_local).toBe("2099-06-02 07:45");
      expect(row.sleep.bedtime_local).toBe("2099-06-01 23:40");
      expect(row.sleep.avg_hrv_ms).toBe(40); // the nap's 99 and the shorter night's 11 are not used
      expect(row.sleep.score).toBe(78); // daily_sleep, not a field on the sleep document
      expect(row.sleep.temperature_deviation_c).toBe(-0.2);
      expect(row.readiness).toBe(80);
      expect(row.previous_day.steps).toBe(8400);
      expect(row.previous_day.classes).toBe(1);
      expect(row.previous_day.class_minutes).toBe(60);
      expect(row.previous_day.tags).toEqual(["sauna"]);
    });
  });

  it("says too early under 14 mornings, and an early pattern at 14", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxAt(tx, "2099-08-31T17:00:00Z");
      // Only mornings with a main sleep count, so give each test morning one (rolled back).
      const night = async (dd: string) => {
        await tx`insert into oura_documents (collection, id, day, start_at, end_at, data)
          values ('sleep', ${"t-night-" + dd}, ${"2099-08-" + dd}, ${"2099-08-" + dd + "T06:00:00Z"}, ${"2099-08-" + dd + "T14:00:00Z"},
                  ${tx.json({ type: "long_sleep", total_sleep_duration: 27000 } as never)})`;
      };
      for (let i = 1; i <= 14; i++) await night(String(i).padStart(2, "0"));
      for (let i = 1; i <= 13; i++) {
        await logCheckin(ctxAt(tx, `2099-08-${String(i).padStart(2, "0")}T16:00:00Z`), { rating: (i % 5) + 1 });
      }
      const early = await getFeelVsRing(ctx, { days: 40 });
      expect(early.rated_mornings).toBe(13);
      expect(early.confidence).toBe("too early");
      expect(early.all.confidence).toBe("too early");
      expect(early.within_2h.confidence).toBe("too early");
      await logCheckin(ctxAt(tx, "2099-08-14T16:00:00Z"), { rating: 3 });
      const pattern = await getFeelVsRing(ctx, { days: 40 });
      expect(pattern.rated_mornings).toBe(14);
      expect(pattern.confidence).toBe("early pattern, not proven");
      expect(pattern.all.note).toMatch(/not proven/);
    });
  });
});
