import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import type { SyncDeps, SyncResult } from "@/core/hevy/sync";
import type { OuraSyncDeps, OuraSyncResult } from "@/core/oura/sync";

// The syncs are faked (no Hevy or Oura calls); sync_state, the lease and the Oura login check are REAL rows inside an
// always-rolled-back transaction.
const hevyMock = vi.fn<(d: SyncDeps) => Promise<SyncResult>>();
const ouraMock = vi.fn<(d: OuraSyncDeps, o?: { only?: readonly string[] }) => Promise<OuraSyncResult[]>>();
vi.mock("@/core/hevy/sync", () => ({ syncHevyWorkouts: (d: SyncDeps) => hevyMock(d) }));
vi.mock("@/core/oura/sync", () => ({ syncOura: (d: OuraSyncDeps, o?: { only?: readonly string[] }) => ouraMock(d, o) }));
import { ensureFresh } from "@/core/freshness";
import { claimLease } from "@/core/lease";
import { QUICK_REFRESH } from "@/core/oura/collections";

try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      // "connected" = a token row exists; never modify the real one (insert only if missing, rolled back anyway).
      // Token row FIRST, then sync_state: the same lock order as the other DB tests, or parallel test files deadlock.
      await tx`insert into oauth_tokens (provider, access_token, refresh_token, expires_at) values ('oura', 'x', 'y', now() + interval '1 day') on conflict do nothing`;
      await tx`delete from sync_state where source = 'hevy_workouts' or source like 'oura:%'`;
      await tx`delete from settings where key like 'lease:%'`;
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const NOW = new Date("2026-10-11T19:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hevyDeps = (tx: Sql): SyncDeps => ({ sql: tx, hevy: {} as never, timezone: "America/Los_Angeles", now: () => NOW });
const ouraDeps = (tx: Sql): OuraSyncDeps => ({ sql: tx, oura: {} as never, timezone: "America/Los_Angeles", now: () => NOW });
const okAt = (tx: Sql, source: string, at: Date, error: string | null = null) =>
  tx`insert into sync_state (source, last_ok_at, last_run_at, last_error) values (${source}, ${at}, ${at}, ${error})`;
const allOuraOkAt = async (tx: Sql, at: Date) => { for (const n of QUICK_REFRESH) await okAt(tx, `oura:${n}`, at); };
const ouraOk = (): OuraSyncResult[] => QUICK_REFRESH.map((n) => ({ source: `oura:${n}`, ok: true, complete: true }));

beforeEach(() => { hevyMock.mockReset(); ouraMock.mockReset(); });

describe.skipIf(!sql)("ensureFresh: quick, capped, leased lazy refresh (rolled-back DB)", () => {
  it("does nothing when everything is under 3 hours old", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(1));
      await allOuraOkAt(tx, hoursAgo(2));
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(hevyMock).not.toHaveBeenCalled();
      expect(ouraMock).not.toHaveBeenCalled();
      expect(r.hevy).toMatchObject({ refreshed: false, asOf: hoursAgo(1).toISOString() });
      expect(r.oura).toMatchObject({ refreshed: false, asOf: hoursAgo(2).toISOString() });
      expect(r.hevy!.note).toBeUndefined();
    });
  });

  it("judges Oura by its OLDEST quick source: fresh readiness can't hide a stale workout feed", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(1));
      await allOuraOkAt(tx, hoursAgo(1));
      await tx`update sync_state set last_ok_at = ${hoursAgo(5)} where source = 'oura:workout'`;
      ouraMock.mockResolvedValue(ouraOk());
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(ouraMock).toHaveBeenCalledOnce();
      expect(ouraMock.mock.calls[0][1]?.only).toEqual(QUICK_REFRESH); // only the sources the tools read
      expect(ouraMock.mock.calls[0][0].budgetMs).toBe(6_000);
      expect(hevyMock).not.toHaveBeenCalled(); // Hevy was fresh
      expect(r.oura?.refreshed).toBe(true);
    });
  });

  it("ignores a quick source Oura refuses for this account (it would otherwise look stale forever)", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(1));
      await allOuraOkAt(tx, hoursAgo(1));
      await tx`update sync_state set last_ok_at = null, last_error = 'unavailable: denied' where source = 'oura:daily_spo2'`;
      await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(ouraMock).not.toHaveBeenCalled();
    });
  });

  it("refreshes Hevy and Oura at the same time when both are stale, and releases the lease afterwards", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(5));
      let hevyStarted = false, ouraSawHevyStarted = false;
      hevyMock.mockImplementation(async () => { hevyStarted = true; await new Promise((r) => setTimeout(r, 30)); return { source: "hevy_workouts", ok: true, complete: true }; });
      ouraMock.mockImplementation(async () => { ouraSawHevyStarted = hevyStarted; return ouraOk(); });
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(hevyMock).toHaveBeenCalledOnce();
      expect(ouraSawHevyStarted).toBe(true); // Oura started while Hevy was still running
      expect(r.hevy!.refreshed).toBe(true);
      expect(await claimLease(tx, "quick_refresh:hevy", 30)).not.toBeNull(); // released, so they can be claimed again
      expect(await claimLease(tx, "quick_refresh:oura", 30)).not.toBeNull();
    });
  });

  it("skips the refresh and says why when another request holds the lease", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(5));
      await allOuraOkAt(tx, hoursAgo(1));
      expect(await claimLease(tx, "quick_refresh:hevy", 30)).not.toBeNull(); // someone else is refreshing Hevy
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(hevyMock).not.toHaveBeenCalled();
      expect(r.hevy).toMatchObject({ refreshed: false, asOf: hoursAgo(5).toISOString() });
      expect(r.hevy!.note).toMatch(/another request is refreshing/);
      expect(r.oura?.note).toBeUndefined(); // Oura was fresh: nothing to say
    });
  });

  it("leases are per source: someone refreshing Hevy doesn't stop this call refreshing Oura", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(5));
      await allOuraOkAt(tx, hoursAgo(5));
      expect(await claimLease(tx, "quick_refresh:hevy", 30)).not.toBeNull(); // a Hevy-only tool is refreshing Hevy
      ouraMock.mockResolvedValue(ouraOk());
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(hevyMock).not.toHaveBeenCalled();
      expect(r.hevy!.note).toMatch(/another request is refreshing/);
      expect(ouraMock).toHaveBeenCalledOnce();
      expect(r.oura?.refreshed).toBe(true);
    });
  });

  it("stops waiting at the cap and answers from stored data with a note", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(5));
      hevyMock.mockImplementation(() => new Promise(() => {})); // never finishes
      ouraMock.mockImplementation(() => new Promise(() => {}));
      const t0 = Date.now();
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx), { capMs: 50 });
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(r.hevy!.note).toMatch(/took too long/);
      expect(r.oura?.note).toMatch(/took too long/);
    });
  });

  it("never throws: a failing sync becomes a note", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(5));
      await allOuraOkAt(tx, hoursAgo(5));
      hevyMock.mockRejectedValue(new Error("db down"));
      ouraMock.mockResolvedValue([{ source: "oura:workout", ok: false, error: "boom" }, { source: "oura:sleep", ok: true, complete: true }]);
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(r.hevy!.note).toMatch(/refresh failed/);
      expect(r.oura?.note).toMatch(/some sources failed \(oura:workout\)/);
    });
  });

  it("a partial refresh (time ran out before some sources started) is flagged, not reported as fully fresh", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(1));
      ouraMock.mockResolvedValue([{ source: "oura:sleep", ok: true, complete: true }, { source: "oura:workout", ok: true, complete: false, skipped: true }]);
      const r = await ensureFresh(hevyDeps(tx), ouraDeps(tx));
      expect(r.oura?.note).toMatch(/partly done/);
    });
  });

  it("tools that don't read Oura never touch it", async () => {
    await inTest(async (tx) => {
      await okAt(tx, "hevy_workouts", hoursAgo(1));
      const r = await ensureFresh(hevyDeps(tx), null);
      expect(ouraMock).not.toHaveBeenCalled();
      expect(r.oura).toBeNull();
    });
  });
});

describe.skipIf(!sql)("claimLease (rolled-back DB)", () => {
  it("only one holder at a time; an expired claim can be taken over; release frees it", async () => {
    await inTest(async (tx) => {
      const a = await claimLease(tx, "test_job", 30);
      expect(a).not.toBeNull();
      expect(await claimLease(tx, "test_job", 30)).toBeNull();
      await a!();
      const b = await claimLease(tx, "test_job", 30);
      expect(b).not.toBeNull();
      // b dies without releasing; once its claim is older than the TTL, a newcomer takes over
      await tx`update settings set value = (now() - interval '31 seconds')::text || '|' || split_part(value, '|', 2) where key = 'lease:test_job'`;
      const c = await claimLease(tx, "test_job", 30);
      expect(c).not.toBeNull();
      await b!(); // b's late release must NOT free c's claim
      expect(await claimLease(tx, "test_job", 30)).toBeNull();
    });
  });
});
