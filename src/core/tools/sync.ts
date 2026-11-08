import type { Sql } from "../db";
import { syncHevy, type SyncDeps, type SyncResult } from "../hevy/sync";
import { syncOura, type OuraSyncDeps, type OuraSyncResult } from "../oura/sync";
import { isConnected } from "../oura/tokens";
import { processPending } from "../apple/process";

export async function syncNow(deps: SyncDeps, oura: OuraSyncDeps | null, source: "hevy" | "oura" | "apple" | "all" = "all", opts: { reprocess_all?: boolean } = {}) {
  const out: Record<string, unknown> = { source, as_of: new Date().toISOString() };
  if (source === "hevy" || source === "all") {
    if (!deps.hevy) out.hevy = { skipped: "Hevy isn't set up: HEVY_API_KEY is missing." };
    else {
      const results: SyncResult[] = await syncHevy(deps);
      out.hevy = { results, verify: await verifyWorkoutCount(deps) };
    }
  }
  if (source === "oura" || source === "all") out.oura = await syncOuraNow(deps, oura);
  // Apple Health is pushed by the phone and cannot be pulled; this only (re)processes bodies already received.
  if (source === "apple" || source === "all") out.apple = await processPending(deps.sql, deps.timezone, { all: opts.reprocess_all });
  return out;
}

// Compact on purpose: 15 sources would drown the answer. Failures are listed individually.
async function syncOuraNow(deps: SyncDeps, oura: OuraSyncDeps | null) {
  if (!oura) return { skipped: "Oura isn't set up: OURA_CLIENT_ID / OURA_CLIENT_SECRET are missing." };
  if (!(await isConnected(deps.sql))) return { skipped: "Oura isn't connected yet. Ask for connect_oura first." };
  const results: OuraSyncResult[] = await syncOura(oura);
  return {
    sources_ok: results.filter((r) => r.ok).length,
    sources_total: results.length,
    complete: results.every((r) => r.ok && r.complete !== false),
    unavailable: results.filter((r) => r.unavailable).map((r) => r.source.replace("oura:", "")),
    rows_this_run: results.reduce((n, r) => n + (r.rows ?? 0), 0),
    ...(results.some((r) => r.complete === false) ? { note: "Still catching up on history: call sync_now again until complete is true." } : {}),
    failed: results.filter((r) => !r.ok).map((r) => ({ source: r.source, error: r.error })),
  };
}

// "Backfill is correct" = our non-deleted count equals Hevy's own count.
async function verifyWorkoutCount(deps: SyncDeps) {
  try {
    const [row] = await deps.sql<{ n: string }[]>`select count(*) as n from workouts where not deleted`;
    const hevyCount = await deps.hevy!.getWorkoutCount();
    const dbCount = Number(row.n);
    return { db_count: dbCount, hevy_count: hevyCount, match: dbCount === hevyCount };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function getSyncStatus(sql: Sql) {
  const states = await sql<{ source: string; cursor: string | null; last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null }[]>`
    select source, cursor, last_run_at, last_ok_at, last_error from sync_state order by source`;
  const [w] = await sql<{ total: string; live: string; deleted: string; latest: string | null }[]>`
    select count(*) as total, count(*) filter (where not deleted) as live,
           count(*) filter (where deleted) as deleted, (max(local_date) filter (where not deleted))::text as latest
    from workouts`;
  const [t] = await sql<{ n: string }[]>`select count(*) as n from exercise_templates`;
  const backfill = states.find((s) => s.source === "hevy_backfill")?.cursor;

  const ouraStates = states.filter((s) => s.source.startsWith("oura:"));
  const docs = await sql<{ collection: string; n: string; first_day: string | null; last_day: string | null }[]>`
    select collection, count(*) as n, min(day)::text as first_day, max(day)::text as last_day from oura_documents group by 1 order by 1`;
  const [hr] = await sql<{ n: string; first: Date | null; last: Date | null }[]>`select count(*) as n, min(ts) as first, max(ts) as last from hr_samples`;
  const oldestOk = ouraStates.map((s) => s.last_ok_at).filter(Boolean).sort()[0] ?? null;
  const isUnavailable = (s: { last_error: string | null }) => !!s.last_error?.startsWith("unavailable:");
  const caughtUp = ouraStates.length > 0 && ouraStates.every((s) => isUnavailable(s) || (s.last_ok_at && !s.last_error));

  return {
    sources: states
      .filter((s) => s.source !== "hevy_backfill" && !s.source.startsWith("oura:"))
      .map((s) => ({ source: s.source, last_ok_at: s.last_ok_at, last_run_at: s.last_run_at, last_error: s.last_error })),
    hevy: {
      workouts: Number(w.live),
      workouts_deleted: Number(w.deleted),
      latest_workout_date: w.latest,
      exercise_templates: Number(t.n),
      backfill: backfill === "done" ? "complete" : backfill ? `in progress (next page ${backfill})` : "not started",
    },
    oura: {
      connected: await isConnected(sql),
      sources_ok: ouraStates.filter((s) => isUnavailable(s) || (s.last_ok_at && !s.last_error)).length,
      unavailable_for_this_account: ouraStates.filter(isUnavailable).map((s) => s.source.replace("oura:", "")),
      sources_total: ouraStates.length,
      all_sources_healthy: caughtUp,
      oldest_last_ok_at: oldestOk,
      errors: ouraStates.filter((s) => s.last_error && !isUnavailable(s)).map((s) => ({ source: s.source, error: s.last_error })),
      documents: Object.fromEntries(docs.map((d) => [d.collection, { count: Number(d.n), first_day: d.first_day, last_day: d.last_day }])),
      heart_rate_samples: { count: Number(hr.n), first: hr.first, last: hr.last },
    },
    as_of: new Date().toISOString(),
  };
}
