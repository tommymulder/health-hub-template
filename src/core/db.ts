import postgres, { type Sql } from "postgres";

export type { Sql };

// We talk to Supabase's pooler (Supavisor) in SESSION mode (port 5432 on the pooler host): each connection keeps
// the same database backend for its whole life. Transaction mode (port 6543, the URL as stored) HUNG real calls on
// 2026-10-11: postgres.js pipelines queries and, with prepare:false, sends each query with parameters in two steps
// ("describe", then "run"); transaction mode can hand the second step to a different backend, and both sides then
// wait forever. A stress test (test/db-pooler.db.test.ts) got stuck 6 rounds of 6 in transaction mode, also with
// pipelining limited to 1 (0 breaks transactions), and finished 6 of 6 in session mode.
// Session mode allows at most the pool size of clients (~15 on the free plan): fine for one user, max:1 per server
// copy, and idle connections close after 20 s.
export function sessionModeUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "6543") u.port = "5432";
  return u.toString();
}

export function createSql(databaseUrl: string): Sql {
  return postgres(sessionModeUrl(databaseUrl), {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// Run fn atomically. Inside an existing transaction (tests wrap everything in
// one and roll it back) we use a savepoint instead of starting a new one.
export function inTx<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const s = sql as unknown as {
    savepoint?: (f: (tx: Sql) => Promise<T>) => Promise<T>;
    begin: (f: (tx: Sql) => Promise<T>) => Promise<T>;
  };
  return typeof s.savepoint === "function" ? s.savepoint(fn) : s.begin(fn);
}
