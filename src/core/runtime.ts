import { getConfig, getOuraConfig, type OuraConfig } from "./config";
import { createSql, type Sql } from "./db";
import { createHevyClient } from "./hevy/client";
import { createHevyWriter, type HevyWriteApi } from "./hevy/write";
import type { SyncDeps } from "./hevy/sync";
import { createOuraClient } from "./oura/client";
import type { OuraSyncDeps } from "./oura/sync";
import { forceRefresh, getAccessToken, type TokenDeps } from "./oura/tokens";
import { ToolError, type ToolCtx } from "./tools/context";

// Builds real dependencies from the environment. The Next routes call this;
// tests build their own deps with fakes instead.
let cached: { sql: Sql; deps: SyncDeps; ctx: ToolCtx; writer: HevyWriteApi | null } | undefined;

function init() {
  if (!cached) {
    const cfg = getConfig();
    const sql = createSql(cfg.databaseUrl);
    cached = {
      sql,
      deps: { sql, hevy: cfg.hevyApiKey ? createHevyClient({ apiKey: cfg.hevyApiKey }) : null, timezone: cfg.timezone },
      ctx: { sql, timezone: cfg.timezone, units: cfg.units, hrMax: cfg.hrMax, hrZones: cfg.hrZones, modules: cfg.modules, labPreferredPerformers: cfg.labPreferredPerformers },
      writer: cfg.hevyApiKey ? createHevyWriter({ apiKey: cfg.hevyApiKey }) : null,
    };
  }
  return cached;
}

export const getSyncDeps = (): SyncDeps => init().deps;
export const getToolCtx = (): ToolCtx => init().ctx;
// Only the Hevy tools call this, and they are not registered without HEVY_API_KEY; the throw is a last guard.
export const getHevyWriter = (): HevyWriteApi => {
  const w = init().writer;
  if (!w) throw new ToolError("Hevy isn't set up: HEVY_API_KEY is missing.");
  return w;
};
export const getRuntimeSql = (): Sql => init().sql;

// After a call got stuck, throw this server copy's database connection away so the NEXT call opens a fresh one
// (2026-10-11: once one call was stuck, every later call on the same server copy hung too, until Vercel killed it).
// Work still using the old connection fails fast instead of hanging; every sync write is an idempotent upsert.
export function resetRuntime(): void {
  const old = cached;
  cached = undefined;
  ouraCached = undefined;
  old?.sql.end({ timeout: 0 }).catch(() => {});
}

// Oura is optional until its client id/secret exist; null means "not set up" (callers say so).
let ouraCached: { cfg: OuraConfig; deps: OuraSyncDeps } | null | undefined;
export function getOuraRuntime(): { cfg: OuraConfig; deps: OuraSyncDeps } | null {
  if (ouraCached !== undefined) return ouraCached;
  try {
    const cfg = getOuraConfig();
    const base = init();
    const tokenDeps: TokenDeps = { sql: base.sql, clientId: cfg.clientId, clientSecret: cfg.clientSecret };
    const oura = createOuraClient({
      getAccessToken: () => getAccessToken(tokenDeps),
      forceRefresh: (rejected) => forceRefresh(tokenDeps, rejected),
    });
    ouraCached = { cfg, deps: { sql: base.sql, oura, timezone: base.deps.timezone } };
  } catch {
    ouraCached = null;
  }
  return ouraCached;
}
