import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { captureIngest, describePayload, pickHeaders, RAW_KEEP_DAYS } from "@/core/apple/capture";

try { process.loadEnvFile(".env.local"); } catch { /* no local env file */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const payload = { data: { metrics: [{ name: "weight_body_mass", units: "lb", data: [{ qty: 1 }] }, { name: "step_count" }], workouts: [{}, {}] } };

describe("describePayload", () => {
  it("reports metric names and workout count only", () => {
    expect(describePayload(payload)).toEqual({ metrics: ["weight_body_mass", "step_count"], workouts: 2 });
  });
  it("tolerates odd shapes without throwing", () => {
    expect(describePayload(null)).toEqual({ metrics: [], workouts: 0 });
    expect(describePayload({ data: {} })).toEqual({ metrics: [], workouts: 0 });
    expect(describePayload("x")).toEqual({ metrics: [], workouts: 0 });
  });
});

describe("pickHeaders", () => {
  it("keeps only the allowlist, never the key", () => {
    const h = new Headers({ "x-ingest-key": "SECRET", "automation-aggregation": "false", "session-id": "abc", authorization: "Bearer z" });
    expect(pickHeaders(h)).toEqual({ "automation-aggregation": "false", "session-id": "abc" });
  });
});

describe.skipIf(!sql)("capture mode (always rolled back)", () => {
  it("stores the body untouched, marks the source fresh, and drops raw rows older than the keep window", async () => {
    await inRollback(async (tx) => {
      await tx`delete from raw_ingest`;
      const now = new Date("2026-10-11T12:00:00Z");
      await tx`insert into raw_ingest (source, payload, received_at) values ('apple_health', '{}'::jsonb, ${new Date(now.getTime() - (RAW_KEEP_DAYS + 1) * 86_400_000)})`;
      const res = await captureIngest(tx, payload, 123, now);
      expect(res).toMatchObject({ bytes: 123, workouts: 2 });
      const rows = await tx`select id, payload from raw_ingest`;
      expect(rows.length).toBe(1); // old one pruned
      expect(rows[0].payload).toEqual(payload);
      const [st] = await tx`select last_ok_at, last_error from sync_state where source = 'apple_health'`;
      expect(new Date(st.last_ok_at).toISOString()).toBe(now.toISOString());
      expect(st.last_error).toBeNull();
    });
  });
});
