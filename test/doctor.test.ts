import { describe, it, expect } from "vitest";
import { exitCode, format, runDoctor, SCHEMA_PROOF, type Probes } from "@/core/doctor";

const tables = (rls = true) => SCHEMA_PROOF.map((name) => ({ name, rls }));
const probes = (over: Partial<Probes> = {}): Probes => ({ database: async () => ({ tables: tables() }), ...over });
const GOOD = { MCP_SECRET: "a", DATABASE_URL: "postgres://u:secretpw@h:5432/d", CRON_SECRET: "c", INGEST_KEY: "i", TIMEZONE: "Europe/London", UNITS: "kg" };
const by = (cs: Awaited<ReturnType<typeof runDoctor>>, name: string) => cs.find((c) => c.name === name)!;

describe("doctor", () => {
  it("passes a complete minimal setup, with optional sources skipped", async () => {
    const cs = await runDoctor(GOOD, probes());
    expect(exitCode(cs)).toBe(0);
    expect(by(cs, "Hevy answers").status).toBe("skip");
    expect(by(cs, "Oura app keys").status).toBe("skip");
  });
  it("fails on missing required variables and names them", async () => {
    const cs = await runDoctor({ ...GOOD, MCP_SECRET: "", INGEST_KEY: undefined }, probes());
    expect(exitCode(cs)).toBe(1);
    expect(by(cs, "env MCP_SECRET").status).toBe("fail");
    expect(by(cs, "env INGEST_KEY").status).toBe("fail");
    expect(by(cs, "env CRON_SECRET").status).toBe("pass");
  });
  it("rejects a bad timezone and bad units", async () => {
    const cs = await runDoctor({ ...GOOD, TIMEZONE: "Mars/Olympus", UNITS: "stone" }, probes());
    expect(by(cs, "TIMEZONE").status).toBe("fail");
    expect(by(cs, "UNITS").status).toBe("fail");
  });
  it("catches a table without row level security, and a schema that was never applied", async () => {
    const off = await runDoctor(GOOD, probes({ database: async () => ({ tables: [...tables(), { name: "extra", rls: false }] }) }));
    expect(by(off, "row level security on every table")).toMatchObject({ status: "fail", detail: expect.stringContaining("extra") });
    const empty = await runDoctor(GOOD, probes({ database: async () => ({ tables: [{ name: "workouts", rls: true }] }) }));
    expect(by(empty, "schema applied").status).toBe("fail");
  });
  it("modules: an unknown name fails, and checkins/events need CHECKIN_KEY", async () => {
    expect(by(await runDoctor({ ...GOOD, HUB_MODULES: "clases" }, probes()), "HUB_MODULES").status).toBe("fail");
    expect(by(await runDoctor({ ...GOOD, HUB_MODULES: "events" }, probes()), "env CHECKIN_KEY (for checkins / events)").status).toBe("fail");
    expect(by(await runDoctor({ ...GOOD, HUB_MODULES: "events", CHECKIN_KEY: "k" }, probes()), "env CHECKIN_KEY (for checkins / events)").status).toBe("pass");
  });
  it("probes Hevy and Oura only when their keys are set, and reports failures without values", async () => {
    const cs = await runDoctor({ ...GOOD, HEVY_API_KEY: "k", OURA_CLIENT_ID: "a", OURA_CLIENT_SECRET: "b" },
      probes({ hevy: async () => { throw new Error("Hevy answered 401"); }, ouraConnected: async () => false }));
    expect(by(cs, "Hevy answers")).toMatchObject({ status: "fail", detail: "Hevy answered 401" });
    expect(by(cs, "Oura connected").status).toBe("skip");
    const half = await runDoctor({ ...GOOD, OURA_CLIENT_ID: "a" }, probes());
    expect(by(half, "Oura app keys").status).toBe("fail");
  });
  it("never prints a value: a database error with a URL in it is masked, and no secret appears in any line", async () => {
    const cs = await runDoctor({ ...GOOD, HEVY_API_KEY: "hevy-secret-value" }, probes({
      database: async () => { throw new Error("connect failed postgres://u:secretpw@h:5432/d"); }, hevy: async () => 3 }));
    const text = cs.map(format).join("\n");
    for (const v of ["secretpw", "hevy-secret-value", GOOD.MCP_SECRET + "x"]) expect(text).not.toContain(v);
    expect(by(cs, "database reachable").detail).toContain("[url]");
  });
});
