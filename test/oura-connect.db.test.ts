import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { completeOuraConnect, OuraConnectError, startOuraConnect } from "@/core/oura/connect";

try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inTest(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => { await fn(raw as unknown as Sql); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const cfg = { clientId: "CID", clientSecret: "SECRET", redirectUri: "https://hub.example/api/oura/callback" };
const tokenOk = (calls: string[] = []) => (async (_u: unknown, init: RequestInit) => {
  calls.push(new URLSearchParams(init.body as URLSearchParams).get("code")!);
  return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 86400, scope: "daily heartrate" }), { status: 200 });
}) as unknown as typeof fetch;
const stateOf = (u: string) => new URL(u).searchParams.get("state")!;

describe.skipIf(!sql)("Oura connect flow (rolled-back DB, fake Oura)", () => {
  it("issues an authorize link with our client id, redirect, minimal scopes and a fresh state", async () => {
    await inTest(async (tx) => {
      const r = await startOuraConnect(tx, cfg);
      const u = new URL(r.url);
      expect(u.origin + u.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
      expect(u.searchParams.get("client_id")).toBe("CID");
      expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
      expect(u.searchParams.get("response_type")).toBe("code");
      const scopes = u.searchParams.get("scope")!.split(" ");
      expect(scopes).toEqual(expect.arrayContaining(["daily", "heartrate", "workout", "session", "heart_health"]));
      expect(scopes).not.toContain("email");
      expect(scopes).not.toContain("personal");
      expect(u.searchParams.get("state")).toMatch(/^[0-9a-f]{48}$/);
      expect(JSON.stringify(r)).not.toMatch(/SECRET/); // the client secret never appears in the link
      const [row] = await tx`select used_at from oauth_states where state = ${stateOf(r.url)}`;
      expect(row.used_at).toBeNull();
      expect(stateOf((await startOuraConnect(tx, cfg)).url)).not.toBe(stateOf(r.url)); // states are unique
    });
  });

  it("exchanges the code, stores tokens, and the state works only ONCE", async () => {
    await inTest(async (tx) => {
      await tx`delete from oauth_tokens where provider = 'oura'`;
      const state = stateOf((await startOuraConnect(tx, cfg)).url);
      const calls: string[] = [];
      const deps = { sql: tx, ...cfg, fetchImpl: tokenOk(calls) };
      expect(await completeOuraConnect(deps, { state, code: "CODE1" })).toEqual({ scope: "daily heartrate" });
      const [t] = await tx`select access_token, refresh_token from oauth_tokens where provider = 'oura'`;
      expect(t).toMatchObject({ access_token: "A", refresh_token: "R" });

      await expect(completeOuraConnect(deps, { state, code: "CODE2" })).rejects.toThrow(/expired or was already used/);
      expect(calls).toEqual(["CODE1"]); // the replayed link never reached Oura
    });
  });

  it("rejects an unknown state without calling Oura (CSRF / stray requests)", async () => {
    await inTest(async (tx) => {
      const calls: string[] = [];
      await expect(completeOuraConnect({ sql: tx, ...cfg, fetchImpl: tokenOk(calls) }, { state: "deadbeef", code: "X" })).rejects.toBeInstanceOf(OuraConnectError);
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects a state older than 10 minutes", async () => {
    await inTest(async (tx) => {
      const state = stateOf((await startOuraConnect(tx, cfg)).url);
      await tx`update oauth_states set created_at = now() - interval '11 minutes' where state = ${state}`;
      await expect(completeOuraConnect({ sql: tx, ...cfg, fetchImpl: tokenOk() }, { state, code: "X" })).rejects.toThrow(/expired/);
    });
  });

  it("explains a declined authorization and an incomplete link, and stores nothing", async () => {
    await inTest(async (tx) => {
      await tx`delete from oauth_tokens where provider = 'oura'`;
      const state = stateOf((await startOuraConnect(tx, cfg)).url);
      await expect(completeOuraConnect({ sql: tx, ...cfg }, { state, error: "access_denied" })).rejects.toThrow(/declined or cancelled/);
      await expect(completeOuraConnect({ sql: tx, ...cfg }, { state: null, code: null })).rejects.toThrow(/incomplete/);
      expect((await tx`select 1 from oauth_tokens where provider = 'oura'`).length).toBe(0);
    });
  });

  it("a refused token exchange gives a helpful message and still burns the state", async () => {
    await inTest(async (tx) => {
      const state = stateOf((await startOuraConnect(tx, cfg)).url);
      const bad = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
      await expect(completeOuraConnect({ sql: tx, ...cfg, fetchImpl: bad }, { state, code: "X" })).rejects.toThrow(/redirect URI/);
      const [row] = await tx`select used_at from oauth_states where state = ${state}`;
      expect(row.used_at).not.toBeNull();
    });
  });
});
