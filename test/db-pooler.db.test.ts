import { describe, it, expect } from "vitest";
import { createSql, sessionModeUrl } from "@/core/db";

// Regression test for the 2026-10-11 hangs: several connections (like several server copies) each firing many
// queries at once through the REAL pooler, plus a transaction each. In transaction mode (port 6543) this got stuck
// every round (15-27 of 125 queries answered); createSql uses session mode. Read-only queries, nothing is written.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;

describe("sessionModeUrl", () => {
  it("moves the Supabase pooler from transaction mode (6543) to session mode (5432) and leaves anything else alone", () => {
    expect(sessionModeUrl("postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:6543/postgres")).toBe("postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres");
    expect(sessionModeUrl("postgresql://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres")).toContain(":5432/");
    expect(sessionModeUrl("postgresql://u:p@localhost:6543/postgres")).toContain("localhost:6543/");
  });
});

describe.skipIf(!url)("database connection through the pooler", () => {
  it("simultaneous queries on several connections all get an answer (no pipelining hang)", async () => {
    for (let round = 0; round < 3; round++) {
      const conns = Array.from({ length: 5 }, () => createSql(url!));
      let answered = 0;
      const all = Promise.all(conns.flatMap((sql) => Array.from({ length: 25 }, (_, i) =>
        (i % 3 === 0 ? sql`select source, last_ok_at from sync_state where source = ${"oura:sleep"}`
          : i % 3 === 1 ? sql`select count(*) from oura_documents where collection = ${"workout"} and day >= ${"2026-09-01"}`
          : sql`select now()`).then(() => { answered++; })))
        .concat(conns.map((sql) => sql.begin(async (tx) => { await tx`select ${1}::int`; await tx`select now()`; }).then(() => { answered++; }))));
      const outcome = await Promise.race([all.then(() => "ok"), new Promise((r) => setTimeout(() => r("stuck"), 15_000))]);
      for (const c of conns) await c.end({ timeout: 0 }).catch(() => {});
      expect({ outcome, answered }).toEqual({ outcome: "ok", answered: 130 });
    }
  });
});
