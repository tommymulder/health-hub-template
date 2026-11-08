import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import type { HrRow, OuraApi, OuraDoc } from "@/core/oura/client";
import { syncOura, type OuraSyncDeps } from "@/core/oura/sync";
import { OuraAuthError, OuraDeniedError } from "@/core/oura/tokens";
import { addDays, daysBetween } from "@/core/time";

try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`delete from sync_state where source like 'oura:%'`;
      await tx`delete from settings where key = 'oura_first_day'`;
      // Real Oura data now lives in these tables, so start from empty INSIDE this always-rolled-back transaction.
      await tx`delete from oura_documents`;
      await tx`delete from hr_samples`;
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const NOW = new Date("2026-10-11T19:00:00Z"); // 12:00 Pacific, so local today = 2026-10-11
const TODAY = "2026-10-11";

// A fake Oura that reproduces the REAL quirks: daily endpoints include end_date, `sleep` EXCLUDES it.
interface Call { name: string; start: string; end: string }
function fakeOura(store: Record<string, OuraDoc[]>, hr: HrRow[] = []) {
  const calls: Call[] = [];
  const hrCalls: { start: string; end: string }[] = [];
  const api: OuraApi = {
    collection: async (name, { start_date, end_date }) => {
      calls.push({ name, start: start_date, end: end_date });
      return (store[name] ?? []).filter((d) => {
        const day = String(d.day ?? d.start_day);
        return day >= start_date && (name === "sleep" ? day < end_date : day <= end_date);
      });
    },
    heartRate: async (start, end) => {
      hrCalls.push({ start, end });
      return hr.filter((r) => r.timestamp >= start && r.timestamp <= end);
    },
  };
  return { api, calls, hrCalls };
}
const deps = (tx: Sql, oura: OuraApi, over: Partial<OuraSyncDeps> = {}): OuraSyncDeps => ({ sql: tx, oura, timezone: "America/Los_Angeles", now: () => NOW, budgetMs: 60_000, ...over });
const ready = (day: string, score = 80): OuraDoc => ({ id: `r-${day}`, day, score, contributors: { hrv_balance: 70 } });
const sleepDoc = (day: string, hrv = 30): OuraDoc => ({ id: `s-${day}`, day, type: "long_sleep", average_hrv: hrv, bedtime_start: `${addDays(day, -1)}T23:00:00.000-07:00`, bedtime_end: `${day}T07:00:00.000-07:00` });
const count = async (tx: Sql, collection: string) => Number((await tx`select count(*) as n from oura_documents where collection = ${collection}`)[0].n);
const state = async (tx: Sql, source: string) => (await tx`select cursor, last_ok_at, last_error from sync_state where source = ${source}`)[0];

describe.skipIf(!sql)("Oura sync against Postgres (always rolled back)", () => {
  it("finds the ring's first day once, caches it, and backfills in 90-day windows up to today", async () => {
    await inTest(async (tx) => {
      const days = Array.from({ length: daysBetween("2026-03-10", TODAY) + 1 }, (_, i) => addDays("2026-03-10", i)); // Mar 10 .. today, like the real ring
      const { api, calls } = fakeOura({ daily_readiness: days.map((d) => ready(d)) });
      const results = await syncOura(deps(tx, api));
      expect(results.every((r) => r.ok)).toBe(true);
      const [first] = await tx`select value from settings where key = 'oura_first_day'`;
      expect(first.value).toBe("2026-03-03"); // earliest day minus a 7-day margin
      expect(await count(tx, "daily_readiness")).toBe(days.length);

      const windows = calls.filter((c) => c.name === "daily_readiness" && c.start !== "2020-01-01");
      expect(windows[0].start).toBe("2026-03-03");
      for (const w of windows) expect(daysBetween(w.start, w.end)).toBeLessThanOrEqual(91); // 90-day window + the +1 day
      expect(windows[windows.length - 1].end).toBe(addDays(TODAY, 1));
      expect((await state(tx, "oura:daily_readiness")).cursor).toBe(addDays(TODAY, -3)); // parked 3 days back for the overlap
    });
  });

  it("asks for end_date + 1 so the exclusive `sleep` end can't drop last night's sleep", async () => {
    await inTest(async (tx) => {
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")], sleep: [sleepDoc("2026-10-10"), sleepDoc(TODAY)] });
      await syncOura(deps(tx, api));
      const days = (await tx`select day::text as d from oura_documents where collection = 'sleep' order by day`).map((r) => r.d);
      expect(days).toEqual(["2026-10-10", TODAY]); // today's doc is only present because of the +1
    });
  });

  it("stores the right columns: day, sleep start/end from bedtimes, ignores times without an offset", async () => {
    await inTest(async (tx) => {
      const naive: OuraDoc = { id: "t1", start_day: "2026-10-05", start_time: "2026-10-05T10:00:00", end_time: null };
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")], sleep: [sleepDoc("2026-10-10")], enhanced_tag: [naive] });
      await syncOura(deps(tx, api));
      const [s] = await tx`select day::text as d, start_at, end_at, data->>'average_hrv' as hrv from oura_documents where collection = 'sleep'`;
      expect(s.d).toBe("2026-10-10");
      expect((s.start_at as Date).toISOString()).toBe("2026-10-10T06:00:00.000Z"); // 23:00 PDT on the 9th
      expect((s.end_at as Date).toISOString()).toBe("2026-10-10T14:00:00.000Z");
      expect(s.hrv).toBe("30");
      const [t] = await tx`select day::text as d, start_at from oura_documents where collection = 'enhanced_tag'`;
      expect(t.d).toBe("2026-10-05");
      expect(t.start_at).toBeNull(); // "10:00:00" has no offset: ambiguous, so not guessed
    });
  });

  it("re-fetches the last 3 days every run, so a revised score replaces the old one (idempotent, no duplicates)", async () => {
    await inTest(async (tx) => {
      const store: Record<string, OuraDoc[]> = { daily_readiness: [ready("2026-10-01", 70), ready("2026-10-09", 70), ready("2026-10-10", 70)] };
      const { api, calls } = fakeOura(store);
      await syncOura(deps(tx, api));
      expect(await count(tx, "daily_readiness")).toBe(3);

      store.daily_readiness = [ready("2026-10-01", 70), ready("2026-10-09", 70), ready("2026-10-10", 88)]; // late ring data revised the score
      calls.length = 0;
      await syncOura(deps(tx, api));
      const run2 = calls.filter((c) => c.name === "daily_readiness");
      expect(run2).toHaveLength(1);
      expect(run2[0].start).toBe(addDays(TODAY, -3)); // only the overlap, not the whole history
      expect(await count(tx, "daily_readiness")).toBe(3);
      const [r] = await tx`select data->>'score' as s from oura_documents where collection = 'daily_readiness' and id = 'r-2026-10-10'`;
      expect(r.s).toBe("88");
    });
  });

  it("GAP SAFETY: if the cron missed days, the next run starts from the saved cursor, not from 'today - 3'", async () => {
    await inTest(async (tx) => {
      const { api, calls } = fakeOura({ daily_readiness: [ready("2026-10-01")] });
      await syncOura(deps(tx, api)); // caught up as of Oct 11; cursor = Oct 8
      calls.length = 0;
      const later = new Date("2026-10-21T19:00:00Z"); // ten days later
      await syncOura(deps(tx, api, { now: () => later }));
      const run = calls.filter((c) => c.name === "daily_readiness");
      expect(run[0].start).toBe("2026-10-08"); // covers Oct 8-21: nothing between is lost
    });
  });

  it("is resumable: a tiny time budget stops early, and the next run continues where it left off", async () => {
    await inTest(async (tx) => {
      const days = Array.from({ length: daysBetween("2026-03-10", TODAY) + 1 }, (_, i) => addDays("2026-03-10", i));
      const { api } = fakeOura({ daily_readiness: days.map((d) => ready(d)) });
      const first = await syncOura(deps(tx, api, { budgetMs: 0 }));
      const rd = first.find((r) => r.source === "oura:daily_readiness")!;
      expect(rd.ok).toBe(true);
      expect(rd.complete).toBe(false);
      expect((await state(tx, "oura:daily_readiness"))?.cursor ?? "").not.toBe(addDays(TODAY, -3));
      await syncOura(deps(tx, api));
      expect((await state(tx, "oura:daily_readiness")).cursor).toBe(addDays(TODAY, -3));
      expect(await count(tx, "daily_readiness")).toBe(days.length);
    });
  });

  it("heart rate: windows of at most 7 days, prefixed sources, duplicates ignored, overlap re-fetch is harmless", async () => {
    await inTest(async (tx) => {
      const hr: HrRow[] = [
        { timestamp: "2026-03-05T10:00:00.000Z", bpm: 60, source: "rest" },
        { timestamp: "2026-10-11T00:29:12.000Z", bpm: 122, source: "awake" },
        { timestamp: "2026-10-11T00:29:12.000Z", bpm: 122, source: "awake" }, // exact duplicate
        { timestamp: "2026-10-11T18:30:00.000Z", bpm: 70, source: "workout" },
      ];
      const { api, hrCalls } = fakeOura({ daily_readiness: [ready("2026-03-10")] }, hr);
      await syncOura(deps(tx, api));
      for (const c of hrCalls) expect((Date.parse(c.end) - Date.parse(c.start)) / 86_400_000).toBeLessThanOrEqual(7);
      expect(hrCalls.length).toBeGreaterThan(25); // ~7 months in 7-day windows
      const rows = await tx`select to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS') as t, bpm, source from hr_samples order by ts`;
      expect(rows.map((r) => [r.t, r.bpm, r.source])).toEqual([
        ["2026-03-05T10:00:00", 60, "oura:rest"],
        ["2026-10-11T00:29:12", 122, "oura:awake"],
        ["2026-10-11T18:30:00", 70, "oura:workout"],
      ]);
      const cursor = (await state(tx, "oura:heartrate")).cursor;
      expect(Date.parse(cursor)).toBe(NOW.getTime() - 3 * 86_400_000); // parked 3 days back, like the documents
      hrCalls.length = 0;
      await syncOura(deps(tx, api));
      expect(hrCalls).toHaveLength(1); // incremental: just the recent window
      expect(Number((await tx`select count(*) as n from hr_samples`)[0].n)).toBe(3);
    });
  });

  it("LATE UPLOAD (2026-10-15): heart rate the ring uploads hours after the hub synced past it is picked up by the next run", async () => {
    await inTest(async (tx) => {
      const hr: HrRow[] = [{ timestamp: "2026-10-11T14:00:00.000Z", bpm: 62, source: "awake" }];
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")] }, hr);
      await syncOura(deps(tx, api)); // the hub syncs at 12:00 PT, past the morning class...
      // ...and only then does the ring upload the 7 AM class (a day and a half before the next run)
      hr.push({ timestamp: "2026-10-11T14:05:00.000Z", bpm: 150, source: "workout" }, { timestamp: "2026-10-11T14:06:00.000Z", bpm: 155, source: "workout" });
      await syncOura(deps(tx, api, { now: () => new Date(NOW.getTime() + 36 * 3_600_000) }));
      const rows = await tx`select bpm, source from hr_samples where source = 'oura:workout' order by ts`;
      expect(rows.map((r) => r.bpm)).toEqual([150, 155]);
    });
  });

  it("SLEEP HEART RATE: the sleep documents' 5-minute series lands in hr_samples as oura:sleep, and re-syncing adds nothing", async () => {
    await inTest(async (tx) => {
      const night: OuraDoc = { ...sleepDoc("2026-10-11"), heart_rate: { interval: 300, timestamp: "2026-10-10T23:00:00.000-07:00", items: [null, 58, 57.4, null, 60] } };
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")], sleep: [night] });
      await syncOura(deps(tx, api));
      const rows = await tx`select to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS') as t, bpm, source from hr_samples where source = 'oura:sleep' order by ts`;
      expect(rows.map((r) => [r.t, r.bpm])).toEqual([["2026-10-11T06:05:00", 58], ["2026-10-11T06:10:00", 57], ["2026-10-11T06:20:00", 60]]);
      await syncOura(deps(tx, api));
      expect(Number((await tx`select count(*) as n from hr_samples where source = 'oura:sleep'`)[0].n)).toBe(3);
    });
  });

  it("one failing collection is recorded and the others still sync; the run never throws", async () => {
    await inTest(async (tx) => {
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")], daily_sleep: [{ id: "x", day: "2026-10-01" }] });
      const flaky: OuraApi = { ...api, collection: async (n, r) => { if (n === "daily_activity") throw new Error("Oura GET failed: 500"); return api.collection(n, r); } };
      const results = await syncOura(deps(tx, flaky));
      expect(results.find((r) => r.source === "oura:daily_activity")).toMatchObject({ ok: false });
      expect(results.find((r) => r.source === "oura:daily_sleep")).toMatchObject({ ok: true });
      expect((await state(tx, "oura:daily_activity")).last_error).toMatch(/500/);
      expect((await state(tx, "oura:daily_sleep")).last_error).toBeNull();
    });
  });

  it("an endpoint Oura denies is marked UNAVAILABLE and skipped: the other sources still sync and it is not a failure", async () => {
    await inTest(async (tx) => {
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")] });
      const denied: OuraApi = { ...api, collection: async (n, r) => {
        if (["daily_resilience", "vO2_max"].includes(n)) throw new OuraDeniedError(`Oura denied access to ${n} (HTTP 401)`);
        return api.collection(n, r);
      } };
      const results = await syncOura(deps(tx, denied));
      expect(results.every((r) => r.ok)).toBe(true); // nothing counted as failed
      expect(results.filter((r) => r.unavailable).map((r) => r.source).sort()).toEqual(["oura:daily_resilience", "oura:vO2_max"]);
      expect(results.find((r) => r.source === "oura:heartrate")).toBeDefined(); // the run did not stop early
      expect((await state(tx, "oura:daily_resilience")).last_error).toMatch(/^unavailable:/);
      expect((await state(tx, "oura:daily_readiness")).last_error).toBeNull();
    });
  });

  it("an UNAVAILABLE endpoint is asked again only once a week (each 401 also renews the single-use Oura login)", async () => {
    await inTest(async (tx) => {
      const { api } = fakeOura({ daily_readiness: [ready("2026-10-01")] });
      let asked = 0;
      const denied: OuraApi = { ...api, collection: async (n, r) => {
        if (n === "daily_resilience") { asked++; throw new OuraDeniedError("Oura denied access to daily_resilience (HTTP 401)"); }
        return api.collection(n, r);
      } };
      await syncOura(deps(tx, denied));
      expect(asked).toBe(1);
      const again = await syncOura(deps(tx, denied, { now: () => new Date(NOW.getTime() + 6 * 86_400_000) }));
      expect(asked).toBe(1); // 6 days later: not asked, still reported unavailable (not a failure)
      expect(again.find((r) => r.source === "oura:daily_resilience")).toMatchObject({ ok: true, unavailable: true });
      await syncOura(deps(tx, denied, { now: () => new Date(NOW.getTime() + 8 * 86_400_000) }));
      expect(asked).toBe(2); // a week on: asked again, in case Oura added it
    });
  });

  it("a source the time budget never reached is left untouched: its last_ok_at must not claim it is fresh", async () => {
    await inTest(async (tx) => {
      const old = new Date("2026-10-11T12:00:00Z");
      await tx`insert into sync_state (source, cursor, last_run_at, last_ok_at) values ('oura:workout', '2026-10-08', ${old}, ${old})`;
      const { api, calls } = fakeOura({});
      const results = await syncOura(deps(tx, api, { budgetMs: 0 }));
      expect(results.find((r) => r.source === "oura:workout")).toMatchObject({ ok: true, complete: false, skipped: true });
      expect(calls.filter((c) => c.name === "workout")).toHaveLength(0);
      const st = (await tx`select last_ok_at, last_run_at from sync_state where source = 'oura:workout'`)[0];
      expect(new Date(st.last_ok_at)).toEqual(old);
      expect(new Date(st.last_run_at)).toEqual(old);
    });
  });

  it("quick refresh (`only`): just the listed sources plus heart rate, all started at once", async () => {
    await inTest(async (tx) => {
      const { api, calls, hrCalls } = fakeOura({ daily_readiness: [ready(TODAY)], workout: [], sleep: [sleepDoc(TODAY)] });
      let inFlight = 0, maxInFlight = 0;
      const slow: OuraApi = { ...api, collection: async (n, r) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 300)); // real Oura replies take ~0.4 s, much longer than a database round trip
        try { return await api.collection(n, r); } finally { inFlight--; }
      } };
      const results = await syncOura(deps(tx, slow), { only: ["daily_readiness", "sleep", "workout", "heartrate"] });
      expect(results.map((r) => r.source).sort()).toEqual(["oura:daily_readiness", "oura:heartrate", "oura:sleep", "oura:workout"]);
      expect(new Set(calls.filter((c) => c.start !== "2020-01-01").map((c) => c.name))).toEqual(new Set(["daily_readiness", "sleep", "workout"]));
      expect(hrCalls.length).toBeGreaterThan(0);
      expect(maxInFlight).toBeGreaterThan(1); // overlapped, not one after another
      expect(await count(tx, "sleep")).toBe(1);
    });
  });

  it("a lost login stops the run early with a clear message, and never throws", async () => {
    await inTest(async (tx) => {
      const dead: OuraApi = {
        collection: async () => { throw new OuraAuthError("Oura disconnected: the stored login was rejected. Ask for connect_oura to reconnect."); },
        heartRate: async () => [],
      };
      const results = await syncOura(deps(tx, dead));
      expect(results.length).toBeLessThanOrEqual(2); // stopped, did not hammer all 15 sources
      expect(results.some((r) => !r.ok && /connect_oura/.test(r.error ?? ""))).toBe(true);
    });
  });
});
