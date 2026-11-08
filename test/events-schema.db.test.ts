import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";

try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try { await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}
// A failed statement poisons a transaction, so each rejected insert gets its own savepoint.
async function rejects(tx: Sql, fn: (tx: Sql) => Promise<unknown>) {
  let failed = false;
  try { await (tx as unknown as { savepoint: (f: (t: Sql) => Promise<unknown>) => Promise<unknown> }).savepoint(async (t) => { await fn(t); }); } catch { failed = true; }
  return failed;
}

describe.skipIf(!sql)("events table (always rolled back)", () => {
  it("is locked down: RLS on, and the public API roles can't read or write it", async () => {
    const [t] = await sql!`select relrowsecurity from pg_class where relname = 'events' and relnamespace = 'public'::regnamespace`;
    expect(t.relrowsecurity).toBe(true);
    // The API roles exist on Supabase only; plain Postgres (CI) has none, and RLS above is then the whole check.
    const [{ roles }] = await sql!`select count(*)::int as roles from pg_roles where rolname in ('anon', 'authenticated')`;
    if (roles < 2) return;
    const [p] = await sql!`select has_table_privilege('anon', 'public.events', 'select') as a, has_table_privilege('authenticated', 'public.events', 'select') as b,
                                  has_table_privilege('anon', 'public.events', 'insert') as c, has_table_privilege('authenticated', 'public.events', 'insert') as d`;
    expect(p).toEqual({ a: false, b: false, c: false, d: false });
  });

  it("only allows known types and sources, a 200-character note, and defaults hidden/approximate to false", async () => {
    await inRollback(async (tx) => {
      const [row] = await tx`insert into events (type, at, source) values ('bathroom', '2031-01-01T10:00:00Z', 'shortcut') returning id, hidden, approximate, note, created_at`;
      expect(row).toMatchObject({ hidden: false, approximate: false, note: null });
      expect(row.created_at).toBeInstanceOf(Date);
      expect(await rejects(tx, (t) => t`insert into events (type, at, source) values ('coffee', now(), 'shortcut')`)).toBe(true);
      expect(await rejects(tx, (t) => t`insert into events (type, at, source) values ('bathroom', now(), 'telepathy')`)).toBe(true);
      expect(await rejects(tx, (t) => t`insert into events (type, at, source, note) values ('bathroom', now(), 'claude', ${"x".repeat(201)})`)).toBe(true);
      expect(await rejects(tx, (t) => t`insert into events (type, at, source, note) values ('bathroom', now(), 'claude', ${"x".repeat(200)})`)).toBe(false);
      expect((await tx`select count(*)::int as n from pg_indexes where tablename = 'events' and indexdef like '%(type, at)%'`)[0].n).toBe(1);
    });
  });
});
