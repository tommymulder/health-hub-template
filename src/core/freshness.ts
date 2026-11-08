import type { Sql } from "./db";
import { withDeadline, TIMED_OUT } from "./deadline";
import { syncHevyWorkouts, type SyncDeps } from "./hevy/sync";
import { claimLease } from "./lease";
import { QUICK_REFRESH } from "./oura/collections";
import { syncOura, type OuraSyncDeps } from "./oura/sync";
import { isConnected } from "./oura/tokens";

export interface Freshness {
  asOf: string | null; // last successful sync (for Oura: the OLDEST of the sources the tools read)
  refreshed: boolean;
  note?: string; // set when the answer may be stale
}
export interface FreshnessReport { hevy: Freshness | null; oura: Freshness | null } // hevy null = Hevy is not set up

const THREE_HOURS = 3 * 60 * 60 * 1000;
// Lazy refresh (DESIGN D3): when a read tool notices data older than 3 h, it does a quick incremental sync first.
// It must stay QUICK, because the answer waits for it (2026-10-11: a slow refresh preceded a call that never answered):
export const QUICK_BUDGET_MS = 6_000; // the syncs stop starting new steps after this
export const REFRESH_CAP_MS = 10_000; // stop waiting and answer from stored data (an in-flight step is bounded by its own request timeout)
const LEASE_TTL_S = 30;

const iso = (d: Date | null) => d?.toISOString() ?? null;

async function hevyLastOk(sql: Sql): Promise<Date | null> {
  const [row] = await sql<{ last_ok_at: Date | null }[]>`select last_ok_at from sync_state where source = 'hevy_workouts'`;
  return row?.last_ok_at ? new Date(row.last_ok_at) : null;
}

// Oura is as fresh as its OLDEST quick source: judging by one source (readiness) once let today's workouts stay
// missing for 3 h because readiness had refreshed and workouts hadn't. A source Oura refuses for this account is ignored.
export async function ouraOldestOk(sql: Sql): Promise<Date | null> {
  const sources = QUICK_REFRESH.map((n) => `oura:${n}`);
  const rows = await sql<{ source: string; last_ok_at: Date | null; last_error: string | null }[]>`
    select source, last_ok_at, last_error from sync_state where source in ${sql(sources)}`;
  const bySource = new Map(rows.map((r) => [r.source, r]));
  let oldest: Date | null = null;
  for (const s of sources) {
    const r = bySource.get(s);
    if (r?.last_error?.startsWith("unavailable:")) continue;
    if (!r?.last_ok_at) return null; // never synced: stale
    const t = new Date(r.last_ok_at);
    if (!oldest || t < oldest) oldest = t;
  }
  return oldest;
}

async function refreshHevy(deps: SyncDeps, before: Date | null, budgetMs: number): Promise<Freshness> {
  const stale = (why: string): Freshness => ({ asOf: iso(before), refreshed: false, note: `Hevy data may be out of date (last synced ${iso(before) ?? "never"}): ${why}` });
  try {
    const result = await syncHevyWorkouts({ ...deps, budgetMs });
    if (!result.ok) return stale("the refresh failed");
    const after = await hevyLastOk(deps.sql);
    return {
      asOf: iso(after ?? before),
      refreshed: true,
      ...(result.complete === false ? { note: `Hevy data may be out of date (last synced ${iso(before) ?? "never"}): the refresh is only partly done; call sync_now` } : {}),
    };
  } catch {
    return stale("the refresh failed");
  }
}

async function refreshOura(deps: OuraSyncDeps, before: Date | null, budgetMs: number): Promise<Freshness> {
  const stale = (why: string): Freshness => ({ asOf: iso(before), refreshed: false, note: `Oura data may be out of date (last synced ${iso(before) ?? "never"}): ${why}` });
  try {
    const results = await syncOura({ ...deps, budgetMs }, { only: QUICK_REFRESH });
    const failed = results.filter((r) => !r.ok);
    const after = await ouraOldestOk(deps.sql);
    if (failed.some((f) => f.error?.includes("connect_oura"))) return stale("the Oura login was lost; ask for connect_oura");
    if (failed.length) return { ...stale(`some sources failed (${failed.map((f) => f.source).join(", ")})`), asOf: iso(after ?? before) };
    if (results.some((r) => r.complete === false)) return { ...stale("the refresh is only partly done; call sync_now"), asOf: iso(after ?? before), refreshed: true };
    return { asOf: iso(after ?? before), refreshed: true };
  } catch {
    return stale("the refresh failed");
  }
}

// Before a read tool answers: refresh whatever is over 3 h old (Hevy when it is set up, Oura when the tool reads it), both at
// once, under a lease per source so simultaneous calls don't each start one, and never wait longer than REFRESH_CAP_MS.
// Never throws: on any trouble the caller answers with the stored data and the note says why.
export async function ensureFresh(
  deps: SyncDeps,
  oura: OuraSyncDeps | null,
  opts: { maxAgeMs?: number; budgetMs?: number; capMs?: number } = {},
): Promise<FreshnessReport> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const maxAge = opts.maxAgeMs ?? THREE_HOURS;
  const budgetMs = opts.budgetMs ?? QUICK_BUDGET_MS;
  const capMs = opts.capMs ?? REFRESH_CAP_MS;
  try {
    const hevyOn = !!deps.hevy;
    const hevyBefore = hevyOn ? await hevyLastOk(deps.sql) : null;
    const hevyStale = hevyOn && (!hevyBefore || now - hevyBefore.getTime() >= maxAge);
    const ouraConnected = oura ? await isConnected(deps.sql) : false;
    const ouraBefore = ouraConnected ? await ouraOldestOk(deps.sql) : null;
    const ouraStale = ouraConnected && (!ouraBefore || now - ouraBefore.getTime() >= maxAge);

    const hevyAsIs: Freshness = { asOf: iso(hevyBefore), refreshed: false };
    const ouraAsIs: Freshness | null = !oura ? null
      : !ouraConnected ? { asOf: null, refreshed: false, note: "Oura is not connected yet (ask for connect_oura)." }
      : { asOf: iso(ouraBefore), refreshed: false };
    if (!hevyStale && !ouraStale) return { hevy: hevyOn ? hevyAsIs : null, oura: ouraAsIs };

    const staleNote = (name: string, before: Date | null, why: string) => `${name} data may be out of date (last synced ${iso(before) ?? "never"}): ${why}`;
    const busy = "another request is refreshing it right now, so this answer uses the stored data";
    const late = "the refresh took too long, so this answer uses the stored data; call sync_now to finish it";
    // One lease PER SOURCE: with a single lease, a Hevy-only tool refreshing Hevy made the Oura tools skip Oura.
    // Released when the work really ends; if it never does, the claim expires.
    const leased = async (name: string, stale: boolean, run: () => Promise<Freshness>, asIs: Freshness, before: Date | null, label: string): Promise<Freshness> => {
      if (!stale) return asIs;
      const release = await claimLease(deps.sql, `quick_refresh:${name}`, LEASE_TTL_S);
      if (!release) return { ...asIs, note: staleNote(label, before, busy) };
      return run().finally(() => release().catch(() => {}));
    };
    const work = Promise.all([
      leased("hevy", hevyStale, () => refreshHevy(deps, hevyBefore, budgetMs), hevyAsIs, hevyBefore, "Hevy"),
      ouraAsIs && oura ? leased("oura", ouraStale, () => refreshOura(oura, ouraBefore, budgetMs), ouraAsIs, ouraBefore, "Oura") : Promise.resolve(null),
    ]);
    const done = await withDeadline(work, capMs);
    if (done === TIMED_OUT) {
      return {
        hevy: !hevyOn ? null : hevyStale ? { ...hevyAsIs, note: staleNote("Hevy", hevyBefore, late) } : hevyAsIs,
        oura: ouraStale && ouraAsIs ? { ...ouraAsIs, note: staleNote("Oura", ouraBefore, late) } : ouraAsIs,
      };
    }
    return { hevy: hevyOn ? done[0] : null, oura: done[1] ?? ouraAsIs };
  } catch {
    return {
      hevy: deps.hevy ? { asOf: null, refreshed: false, note: "Hevy data may be out of date: the freshness check failed." } : null,
      oura: oura ? { asOf: null, refreshed: false, note: "Oura data may be out of date: the freshness check failed." } : null,
    };
  }
}
