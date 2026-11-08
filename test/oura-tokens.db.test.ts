import { describe, it, expect, afterAll, afterEach } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { forceRefresh, getAccessToken, OuraAuthError, saveTokens, type TokenDeps } from "@/core/oura/tokens";

// The race test needs REAL concurrency, so it uses two actual connections and COMMITTED rows,
// isolated under a throw-away provider name that is always deleted afterwards.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
const sql2: Sql | undefined = url ? createSql(url) : undefined;
const P = "test-oura-race";
const cleanup = () => sql!`delete from oauth_tokens where provider = ${P}`;
afterEach(async () => { if (sql) await cleanup(); });
afterAll(async () => { await sql?.end({ timeout: 5 }); await sql2?.end({ timeout: 5 }); });

const NOW = new Date("2026-10-11T12:00:00Z");

// A fake Oura token endpoint that behaves like the real one: refresh tokens are SINGLE-USE.
function fakeOura() {
  const valid = new Set(["R0"]);
  let n = 0;
  const calls: string[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    const rt = new URLSearchParams(init.body as URLSearchParams).get("refresh_token")!;
    calls.push(rt);
    await new Promise((r) => setTimeout(r, 150)); // slow enough that overlapping callers collide
    if (!valid.has(rt)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    valid.delete(rt); // the old token dies the moment it is used
    n++;
    valid.add(`R${n}`);
    return new Response(JSON.stringify({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 86400, scope: "daily" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const deps = (s: Sql, fetchImpl: typeof fetch, now = NOW): TokenDeps => ({ sql: s, clientId: "id", clientSecret: "secret", provider: P, fetchImpl, now: () => now });

describe.skipIf(!sql)("Oura token handling against Postgres", () => {
  it("returns the stored token without calling Oura while it is still valid", async () => {
    await saveTokens(sql!, P, { access_token: "A0", refresh_token: "R0", expires_in: 3600 }, NOW);
    const { fetchImpl, calls } = fakeOura();
    expect(await getAccessToken(deps(sql!, fetchImpl))).toBe("A0");
    expect(calls).toHaveLength(0);
  });

  it("refreshes an expiring token and saves the NEW pair (the old refresh token is dead afterwards)", async () => {
    await saveTokens(sql!, P, { access_token: "A0", refresh_token: "R0", expires_in: 30 }, NOW); // < 60 s left
    const { fetchImpl, calls } = fakeOura();
    expect(await getAccessToken(deps(sql!, fetchImpl))).toBe("A1");
    expect(calls).toEqual(["R0"]);
    const [row] = await sql!`select access_token, refresh_token from oauth_tokens where provider = ${P}`;
    expect(row).toMatchObject({ access_token: "A1", refresh_token: "R1" });
  });

  it("RACE: two callers refresh at the same moment -> exactly ONE call to Oura; both get the same token", async () => {
    await saveTokens(sql!, P, { access_token: "A0", refresh_token: "R0", expires_in: 30 }, NOW);
    const { fetchImpl, calls } = fakeOura();
    // two different connections, started together, like two overlapping serverless requests
    const [a, b] = await Promise.all([getAccessToken(deps(sql!, fetchImpl)), getAccessToken(deps(sql2!, fetchImpl))]);
    expect(calls).toEqual(["R0"]); // without the lock the loser would present dead token R0 and be logged out
    expect(a).toBe("A1");
    expect(b).toBe("A1");
    const [row] = await sql!`select refresh_token from oauth_tokens where provider = ${P}`;
    expect(row.refresh_token).toBe("R1");
  });

  it("a forced refresh (Oura said 401) rotates once, but reuses a token someone else already refreshed", async () => {
    await saveTokens(sql!, P, { access_token: "A0", refresh_token: "R0", expires_in: 3600 }, NOW);
    const { fetchImpl, calls } = fakeOura();
    expect(await forceRefresh(deps(sql!, fetchImpl), "A0")).toBe("A1"); // A0 was rejected
    expect(await forceRefresh(deps(sql2!, fetchImpl), "A0")).toBe("A1"); // late caller with the same stale token: no second rotation
    expect(calls).toEqual(["R0"]);
  });

  it("a revoked login is reported as a clear 'reconnect' error", async () => {
    await saveTokens(sql!, P, { access_token: "A0", refresh_token: "DEAD", expires_in: 30 }, NOW);
    const { fetchImpl } = fakeOura();
    await expect(getAccessToken(deps(sql!, fetchImpl))).rejects.toThrow(OuraAuthError);
    await expect(getAccessToken(deps(sql!, fetchImpl))).rejects.toThrow(/connect_oura/);
  });

  it("says so when Oura was never connected", async () => {
    await expect(getAccessToken(deps(sql!, fakeOura().fetchImpl))).rejects.toThrow(/isn't connected/);
  });
});
