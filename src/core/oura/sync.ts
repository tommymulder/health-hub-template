import type { Sql } from "../db";
import { getState, setState } from "../syncState";
import { addDays, localDate } from "../time";
import type { HrRow, OuraApi } from "./client";
import { COLLECTIONS, type CollectionSpec } from "./collections";
import { OuraAuthError, OuraDeniedError } from "./tokens";

export interface OuraSyncDeps {
  sql: Sql;
  oura: OuraApi;
  timezone: string;
  now?: () => Date;
  budgetMs?: number;
}

export interface OuraSyncResult {
  source: string;
  ok: boolean;
  rows?: number;
  complete?: boolean;
  skipped?: boolean; // the time budget ran out before this source started; nothing was touched
  unavailable?: boolean; // Oura refuses this endpoint for this account; skipped, not a failure
  error?: string;
}

const DOC_WINDOW_DAYS = 90; // doc collections returned a multi-year range in one reply, so big windows are fine
// Oura rejects heart-rate ranges over 30 days, but the real constraint is time: the ring yields ~600-1,500 samples a day,
// so a 29-day window (~40k rows) took 20-35 s. 7-day windows keep every step quick, so the time budget can actually stop a run.
const HR_WINDOW_DAYS = 7;
const OVERLAP_DAYS = 3; // scores get revised as late ring data syncs, so re-fetch the last days every run
// Re-fetch the last 3 days of heart rate every run, like the documents (OVERLAP_DAYS): the ring can upload a workout's
// heart rate HOURS late. With a 1-hour overlap, Oct 15's 7 AM class (751 readings, uploaded after the hub had synced
// past 9 AM) was never fetched. Re-fetching is harmless: stored readings are skipped (on conflict do nothing).
export const HR_OVERLAP_MS = OVERLAP_DAYS * 86_400_000;
const DEFAULT_BUDGET_MS = 45_000;
const DOC_CHUNK = 50; // sleep docs are large
const HR_CHUNK = 1000;

// Cursor meaning (both kinds): where the NEXT run starts. Backfill moves it window by window; once caught up
// it is parked a few days/an hour behind "now", so a missed cron day can never leave a gap.

export async function upsertDocuments(sql: Sql, spec: CollectionSpec, docs: { id: string; [k: string]: unknown }[]): Promise<number> {
  const rows = docs.map((d) => ({
    collection: spec.name, id: d.id, day: spec.day(d), start_at: spec.start?.(d) ?? null, end_at: spec.end?.(d) ?? null, data: sql.json(d as never),
  }));
  for (let i = 0; i < rows.length; i += DOC_CHUNK) {
    await sql`
      insert into oura_documents ${sql(rows.slice(i, i + DOC_CHUNK), "collection", "id", "day", "start_at", "end_at", "data")}
      on conflict (collection, id) do update set
        day = excluded.day, start_at = excluded.start_at, end_at = excluded.end_at, data = excluded.data, fetched_at = now()`;
  }
  if (spec.name === "sleep") await insertHeartRate(sql, docs.flatMap(sleepHeartRateRows));
  return rows.length;
}

// A sleep document carries the night's heart rate as one reading every `interval` seconds (5 minutes), starting at
// `timestamp`; null = no reading. Expanding it puts the nights on the same timeline as the daytime readings.
export function sleepHeartRateRows(doc: Record<string, unknown>): HrRow[] {
  const hr = doc.heart_rate as { interval?: unknown; timestamp?: unknown; items?: unknown } | undefined;
  const start = typeof hr?.timestamp === "string" ? Date.parse(hr.timestamp) : NaN;
  const interval = Number(hr?.interval);
  if (!hr || !Array.isArray(hr.items) || !Number.isFinite(start) || !(interval > 0)) return [];
  const rows: HrRow[] = [];
  hr.items.forEach((bpm, i) => {
    if (typeof bpm === "number" && Number.isFinite(bpm)) rows.push({ timestamp: new Date(start + i * interval * 1000).toISOString(), bpm: Math.round(bpm), source: "sleep" });
  });
  return rows;
}

export async function insertHeartRate(sql: Sql, samples: HrRow[]): Promise<number> {
  const rows = samples.filter((s) => Number.isFinite(s.bpm)).map((s) => ({ ts: s.timestamp, bpm: Math.round(s.bpm), source: `oura:${s.source}` }));
  for (let i = 0; i < rows.length; i += HR_CHUNK) {
    await sql`insert into hr_samples ${sql(rows.slice(i, i + HR_CHUNK), "ts", "bpm", "source")} on conflict (ts, source) do nothing`;
  }
  return rows.length;
}

// The ring's first day: the earliest daily_readiness document (cached in settings once found).
async function firstDay(deps: OuraSyncDeps, today: string): Promise<string> {
  const [cached] = await deps.sql<{ value: string }[]>`select value from settings where key = 'oura_first_day'`;
  if (cached) return cached.value;
  const docs = await deps.oura.collection("daily_readiness", { start_date: "2020-01-01", end_date: addDays(today, 1) });
  const days = docs.map((d) => String(d.day ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (days.length === 0) return addDays(today, -30); // nothing yet: don't cache, look again next time
  const first = addDays(days[0], -7);
  await deps.sql`insert into settings (key, value) values ('oura_first_day', ${first}) on conflict (key) do update set value = excluded.value`;
  return first;
}

type Clock = { now: () => Date; deadline: number };
const timeLeft = (c: Clock) => c.now().getTime() < c.deadline;

// Oura answers 401 for data an account doesn't have (for example daily_resilience on some accounts). Each 401 also makes the client renew
// the login once (it can't tell "not included" from "expired"), and Oura's renewal token is single-use, so asking
// every run means a needless renewal every run. Ask again once a week instead, in case Oura adds it.
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// No time left: touch nothing, so the source keeps its real last_ok_at (marking it OK would make stale data look fresh).
const skipped = (source: string): OuraSyncResult => ({ source, ok: true, rows: 0, complete: false, skipped: true });

async function syncCollection(deps: OuraSyncDeps, spec: CollectionSpec, first: string, today: string, clock: Clock): Promise<OuraSyncResult> {
  const source = `oura:${spec.name}`;
  if (!timeLeft(clock)) return skipped(source);
  const prior = await getState(deps.sql, source);
  if (prior?.last_error?.startsWith("unavailable:") && prior.last_run_at && clock.now().getTime() - new Date(prior.last_run_at).getTime() < UNAVAILABLE_RETRY_MS) {
    return { source, ok: true, unavailable: true, complete: true, rows: 0, error: prior.last_error };
  }
  await setState(deps.sql, source, { last_run_at: clock.now() });
  try {
    let start = prior?.cursor ?? first;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) start = first;
    let rows = 0;
    let complete = false;
    while (start <= today && timeLeft(clock)) {
      const end = addDays(start, DOC_WINDOW_DAYS - 1) < today ? addDays(start, DOC_WINDOW_DAYS - 1) : today;
      // ask for end + 1: the daily endpoints include end_date but `sleep` treats it as exclusive, so +1 covers both
      const docs = await deps.oura.collection(spec.name, { start_date: start, end_date: addDays(end, 1) });
      rows += await upsertDocuments(deps.sql, spec, docs);
      if (end >= today) {
        await setState(deps.sql, source, { cursor: addDays(today, -OVERLAP_DAYS) });
        complete = true;
        break;
      }
      start = addDays(end, 1);
      await setState(deps.sql, source, { cursor: start });
    }
    await setState(deps.sql, source, { last_ok_at: clock.now(), last_error: null });
    return { source, ok: true, rows, complete };
  } catch (err) {
    if (err instanceof OuraDeniedError) {
      await setState(deps.sql, source, { last_error: `unavailable: ${err.message}` });
      return { source, ok: true, unavailable: true, complete: true, error: err.message };
    }
    await setState(deps.sql, source, { last_error: (err as Error).message });
    return { source, ok: false, error: (err as Error).message };
  }
}

async function syncHeartRate(deps: OuraSyncDeps, first: string, clock: Clock): Promise<OuraSyncResult> {
  const source = "oura:heartrate";
  if (!timeLeft(clock)) return skipped(source);
  await setState(deps.sql, source, { last_run_at: clock.now() });
  try {
    const nowMs = clock.now().getTime();
    const stored = (await getState(deps.sql, source))?.cursor;
    let startMs = stored && !Number.isNaN(Date.parse(stored)) ? Date.parse(stored) : Date.parse(`${first}T00:00:00Z`);
    let rows = 0;
    let complete = false;
    while (startMs < nowMs && timeLeft(clock)) {
      const endMs = Math.min(startMs + HR_WINDOW_DAYS * 86_400_000, nowMs);
      const samples = await deps.oura.heartRate(new Date(startMs).toISOString(), new Date(endMs).toISOString());
      rows += await insertHeartRate(deps.sql, samples);
      if (endMs >= nowMs) {
        await setState(deps.sql, source, { cursor: new Date(nowMs - HR_OVERLAP_MS).toISOString() });
        complete = true;
        break;
      }
      startMs = endMs;
      await setState(deps.sql, source, { cursor: new Date(startMs).toISOString() });
    }
    await setState(deps.sql, source, { last_ok_at: clock.now(), last_error: null });
    return { source, ok: true, rows, complete };
  } catch (err) {
    if (err instanceof OuraDeniedError) {
      await setState(deps.sql, source, { last_error: `unavailable: ${err.message}` });
      return { source, ok: true, unavailable: true, complete: true, error: err.message };
    }
    await setState(deps.sql, source, { last_error: (err as Error).message });
    return { source, ok: false, error: (err as Error).message };
  }
}

// Each source is independent (one failure doesn't block the rest), except a lost login: that fails
// everything, so stop early. Never throws.
// `only` = the quick refresh a read tool does before answering: just those sources ("heartrate" included by name),
// all at once instead of one after another (each source is mostly waiting on Oura, so they overlap well).
export async function syncOura(deps: OuraSyncDeps, opts: { only?: readonly string[] } = {}): Promise<OuraSyncResult[]> {
  const now = deps.now ?? (() => new Date());
  const clock: Clock = { now, deadline: now().getTime() + (deps.budgetMs ?? DEFAULT_BUDGET_MS) };
  const today = localDate(now(), deps.timezone);
  const results: OuraSyncResult[] = [];
  let first: string;
  try {
    first = await firstDay(deps, today);
  } catch (err) {
    const msg = (err as Error).message;
    await setState(deps.sql, "oura:daily_readiness", { last_error: msg });
    return [{ source: "oura", ok: false, error: msg }];
  }
  if (opts.only) {
    const specs = COLLECTIONS.filter((c) => opts.only!.includes(c.name));
    return Promise.all([
      ...specs.map((spec) => syncCollection(deps, spec, first, today, clock)),
      ...(opts.only.includes("heartrate") ? [syncHeartRate(deps, first, clock)] : []),
    ]);
  }
  for (const spec of COLLECTIONS) {
    const r = await syncCollection(deps, spec, first, today, clock);
    results.push(r);
    if (!r.ok && r.error?.includes("Oura disconnected")) return results;
    if (!r.ok && r.error?.includes("connect_oura")) return results;
  }
  results.push(await syncHeartRate(deps, first, clock));
  return results;
}

export { OuraAuthError };
