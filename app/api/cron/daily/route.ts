import { isBearerAuthorized } from "@/core/auth";
import { getOuraRuntime, getSyncDeps } from "@/core/runtime";
import { syncOura } from "@/core/oura/sync";
import { isConnected } from "@/core/oura/tokens";
import { syncHevy } from "@/core/hevy/sync";

export const maxDuration = 60;

// Vercel cron sends `Authorization: Bearer $CRON_SECRET` (DESIGN §7).
// Never throws: a failing source is recorded in sync_state and reported as JSON.
export async function GET(req: Request) {
  if (!isBearerAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const deps = getSyncDeps();
    const results = await syncHevy(deps);
    // Oura only once it is set up AND connected; each source is independent, so a failure never blocks the rest.
    const oura = getOuraRuntime();
    const ouraResults = oura && (await isConnected(deps.sql)) ? await syncOura({ ...oura.deps, budgetMs: 40_000 }) : [];
    // Counts and status only, never health values, in logs and response.
    console.log("cron/daily", JSON.stringify([...results, ...ouraResults].map((r) => ({ s: r.source, ok: r.ok }))));
    return Response.json({ ok: [...results, ...ouraResults].every((r) => r.ok), results, oura: ouraResults.map((r) => ({ source: r.source, ok: r.ok, complete: r.complete })) });
  } catch (err) {
    console.error("cron/daily failed", (err as Error).message);
    return Response.json({ ok: false, error: "sync failed" }, { status: 500 });
  }
}
