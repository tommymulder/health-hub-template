import { withDeadline, TIMED_OUT } from "../deadline";
import type { FreshnessReport } from "../freshness";
import { ToolError } from "./context";

// Every read tool answers within this, no matter what. On 2026-10-11 two calls never answered and Vercel killed
// them at 60 s ("The connector's server isn't responding"); the database was idle, so the hub itself was stuck.
// The refresh is already capped (freshness.ts), so hitting this means the query part is stuck.
export const READ_DEADLINE_MS = 25_000;

export interface RunReadOpts {
  tool: string;
  oura: boolean; // does this tool read Oura data (adds as_of.oura)
  refresh: () => Promise<FreshnessReport>;
  query: () => Promise<object>;
  deadlineMs?: number;
  onDeadline?: () => void; // e.g. throw away this server copy's database connection, in case it is the stuck part
  log?: (line: string) => void;
}

// One log line per call: tool, timings, which part was running if it got stuck. Status only, never health values.
export async function runRead(o: RunReadOpts): Promise<object> {
  const log = o.log ?? ((line: string) => console.log(line));
  const t0 = Date.now();
  let phase: "refreshing data" | "reading the database" = "refreshing data";
  let refreshMs = 0;
  let fresh: FreshnessReport | undefined;
  const entry = (outcome: string, extra: Record<string, unknown> = {}) =>
    log(`tool ${JSON.stringify({ tool: o.tool, outcome, ms: Date.now() - t0, refresh_ms: refreshMs,
      refreshed: fresh ? { ...(fresh.hevy ? { hevy: fresh.hevy.refreshed } : {}), ...(fresh.oura ? { oura: fresh.oura.refreshed } : {}) } : null, ...extra })}`);

  const work = (async () => {
    fresh = await o.refresh();
    refreshMs = Date.now() - t0;
    phase = "reading the database";
    return o.query();
  })();
  work.catch(() => {}); // if the deadline wins, a later failure must not become an unhandled rejection

  let result: object | typeof TIMED_OUT;
  try {
    result = await withDeadline(work, o.deadlineMs ?? READ_DEADLINE_MS);
  } catch (err) {
    entry("error", { phase, error: err instanceof ToolError ? "ToolError" : String((err as Error).message ?? err).slice(0, 160) });
    throw err;
  }
  if (result === TIMED_OUT) {
    entry("deadline", { phase });
    o.onDeadline?.();
    throw new ToolError(`The hub took too long to answer (stuck while ${phase}). Try the same question again in a moment; if it keeps happening, call get_sync_status.`);
  }
  entry("ok");
  const f = fresh!;
  const notes = [f.hevy?.note, f.oura?.note].filter(Boolean);
  return {
    ...result,
    as_of: { ...(f.hevy ? { hevy: f.hevy.asOf } : {}), ...(o.oura ? { oura: f.oura?.asOf ?? null } : {}) },
    ...(notes.length ? { data_freshness_note: notes.join(" ") } : {}),
  };
}
