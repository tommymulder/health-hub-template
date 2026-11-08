import type { Sql } from "../db";
import { inTx } from "../db";

// Oura refresh tokens are SINGLE-USE: every refresh returns a new pair and kills
// the old one. If two requests refreshed at once, the loser would present a dead
// token and Oura would log the hub out. So refreshes are serialised with a
// database lock: a second caller waits, then simply reuses the token the first
// caller saved (it never calls Oura at all). The UPDATE is also conditional on
// the old refresh token, as a second guard.
export const TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
// Only what the hub reads: no `email`, no `personal` (we don't need identity or body data from Oura).
export const OURA_SCOPES = ["daily", "heartrate", "workout", "session", "tag", "spo2", "heart_health"];

// The LOGIN is gone (refresh rejected, or never connected): nothing can sync until the user reconnects.
export class OuraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OuraAuthError";
  }
}

// ONE endpoint refuses a perfectly valid login (Oura answers 401 for data an account/ring/membership
// doesn't have, e.g. resilience, cardiovascular age, VO2 max). Skip that endpoint, keep the rest.
export class OuraDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OuraDeniedError";
  }
}

export interface TokenDeps {
  sql: Sql;
  clientId: string;
  clientSecret: string;
  provider?: string; // 'oura' (tests use their own provider name)
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface Row { access_token: string; refresh_token: string; expires_at: Date }
const EARLY_MS = 60_000; // refresh a minute before expiry

const providerOf = (d: TokenDeps) => d.provider ?? "oura";
const nowOf = (d: TokenDeps) => (d.now ?? (() => new Date()))();

async function readRow(sql: Sql, provider: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`select access_token, refresh_token, expires_at from oauth_tokens where provider = ${provider}`;
  return row ?? null;
}

export async function isConnected(sql: Sql, provider = "oura"): Promise<boolean> {
  return (await readRow(sql, provider)) !== null;
}

export async function saveTokens(
  sql: Sql,
  provider: string,
  t: { access_token: string; refresh_token: string; expires_in: number; scope?: string },
  now: Date = new Date(),
): Promise<void> {
  await sql`
    insert into oauth_tokens (provider, access_token, refresh_token, expires_at, scope, updated_at)
    values (${provider}, ${t.access_token}, ${t.refresh_token}, ${new Date(now.getTime() + t.expires_in * 1000)}, ${t.scope ?? null}, now())
    on conflict (provider) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, scope = excluded.scope, updated_at = now()`;
}

// The renewal runs inside a transaction that holds the lock, so it must never wait forever. A timeout is an
// ordinary error (not "disconnected"): the stored login is untouched and the next call tries again.
const REFRESH_TIMEOUT_MS = 15_000;

async function postRefresh(deps: TokenDeps, refreshToken: string) {
  const res = await (deps.fetchImpl ?? fetch)(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken, client_id: deps.clientId, client_secret: deps.clientSecret,
    }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      throw new OuraAuthError("Oura disconnected: the stored login was rejected. Ask for connect_oura to reconnect.");
    }
    throw new Error(`Oura token refresh failed (HTTP ${res.status})`);
  }
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
}

// `force` = Oura said 401 even though our expiry bookkeeping looked fine.
async function refreshLocked(deps: TokenDeps, staleAccess: string | null): Promise<string> {
  const provider = providerOf(deps);
  return inTx(deps.sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"oauth_refresh:" + provider}, 0))`;
    const row = await readRow(tx, provider);
    if (!row) throw new OuraAuthError("Oura isn't connected yet. Ask for connect_oura to connect it.");

    // Someone else refreshed while we waited for the lock: reuse their token, don't touch Oura.
    const fresh = row.expires_at.getTime() - nowOf(deps).getTime() > EARLY_MS;
    if (fresh && row.access_token !== staleAccess) return row.access_token;

    const t = await postRefresh(deps, row.refresh_token);
    const updated = await tx`
      update oauth_tokens set access_token = ${t.access_token}, refresh_token = ${t.refresh_token},
        expires_at = ${new Date(nowOf(deps).getTime() + t.expires_in * 1000)}, scope = coalesce(${t.scope ?? null}, scope), updated_at = now()
      where provider = ${provider} and refresh_token = ${row.refresh_token}`;
    if (updated.count === 0) throw new Error("Oura token row changed during refresh; try again.");
    return t.access_token;
  });
}

export async function getAccessToken(deps: TokenDeps): Promise<string> {
  const row = await readRow(deps.sql, providerOf(deps));
  if (!row) throw new OuraAuthError("Oura isn't connected yet. Ask for connect_oura to connect it.");
  if (row.expires_at.getTime() - nowOf(deps).getTime() > EARLY_MS) return row.access_token;
  return refreshLocked(deps, row.access_token);
}

export async function forceRefresh(deps: TokenDeps, rejectedAccessToken: string): Promise<string> {
  return refreshLocked(deps, rejectedAccessToken);
}
