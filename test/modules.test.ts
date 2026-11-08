import { describe, it, expect, afterEach } from "vitest";
import { enabledModules, OPTIONAL_MODULES, parseModules } from "@/core/modules";
import { buildHub } from "../app/api/mcp/hub";
import { GET as checkinToday } from "../app/api/checkin/today/route";
import { POST as checkinPost } from "../app/api/checkin/route";
import { POST as eventsPost } from "../app/api/events/route";

// The module switch (DESIGN Phase 18): the tool list is the core plus exactly what is turned on.
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function toolNames(env: Record<string, string | undefined>): Promise<string[]> {
  const handler = buildHub(env);
  const res = await handler(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  const data = JSON.parse((await res.text()).split("data: ")[1]);
  return data.result.tools.map((t: { name: string }) => t.name).sort();
}

const OPTIONAL_TOOLS: Record<string, string[]> = {
  checkins: ["log_checkin", "get_checkins", "get_feel_vs_ring"],
  classes: ["log_class_workout", "get_class_history"],
  genetics: ["log_genetic_variants", "get_genetics"],
  events: ["log_event"],
};
const HEVY_TOOLS = ["get_recent_workouts", "get_workout_details", "get_exercise_progress", "get_training_summary", "search_exercises", "create_routine", "update_routine"];
const CORE_ALWAYS = ["ping", "sync_now", "get_sync_status", "get_trends", "get_heart_rate", "get_recovery", "get_oura_data", "connect_oura",
  "get_body_metrics", "list_health_types", "get_health_data", "exclude_apple_sample", "get_lab_results", "log_lab_results"];

describe("parseModules", () => {
  it("is empty by default and reads a comma list, ignoring case and spaces", () => {
    expect([...parseModules(undefined, true)]).toEqual([]);
    expect([...parseModules("", true)]).toEqual([]);
    expect([...parseModules(" Checkins , events ", true)].sort()).toEqual(["checkins", "events"]);
  });
  it("rejects an unknown module name instead of skipping it", () => {
    expect(() => parseModules("checkins,clases", true)).toThrow(/unknown module "clases".*checkins, classes, genetics, events/);
  });
  it("classes needs Hevy", () => {
    expect(() => parseModules("classes", false)).toThrow(/needs HEVY_API_KEY/);
    expect(() => parseModules("checkins,genetics", false)).not.toThrow();
  });
  it("reads HUB_MODULES and HEVY_API_KEY from an env object", () => {
    expect([...enabledModules({ HUB_MODULES: "genetics" })]).toEqual(["genetics"]);
    expect(() => enabledModules({ HUB_MODULES: "classes" })).toThrow();
    expect([...enabledModules({ HUB_MODULES: "classes", HEVY_API_KEY: "k" })]).toEqual(["classes"]);
  });
});

describe("tools/list follows the switches", () => {
  it("with every optional module off and Hevy on: the core tools only", async () => {
    expect(await toolNames({ HEVY_API_KEY: "k" })).toEqual([...CORE_ALWAYS, ...HEVY_TOOLS].sort());
  });
  it("with Hevy off too: no Hevy tool is listed, and the rest still works", async () => {
    const names = await toolNames({});
    expect(names).toEqual([...CORE_ALWAYS].sort());
    for (const t of HEVY_TOOLS) expect(names).not.toContain(t);
  });
  for (const m of OPTIONAL_MODULES) {
    it(`turning on "${m}" adds exactly its tools`, async () => {
      const base = await toolNames({ HEVY_API_KEY: "k" });
      const on = await toolNames({ HEVY_API_KEY: "k", HUB_MODULES: m });
      expect(on.filter((n) => !base.includes(n)).sort()).toEqual([...OPTIONAL_TOOLS[m]].sort());
      expect(base.filter((n) => !on.includes(n))).toEqual([]);
    });
  }
  it("every optional tool is accounted for", () => {
    expect(Object.keys(OPTIONAL_TOOLS).sort()).toEqual([...OPTIONAL_MODULES].sort());
  });
});

describe("the web routes of an off module answer 404, before any key", () => {
  const saved = { m: process.env.HUB_MODULES, k: process.env.CHECKIN_KEY };
  afterEach(() => { process.env.HUB_MODULES = saved.m; process.env.CHECKIN_KEY = saved.k; if (saved.m === undefined) delete process.env.HUB_MODULES; if (saved.k === undefined) delete process.env.CHECKIN_KEY; });
  const post = (url: string) => new Request(url, { method: "POST", headers: { "x-checkin-key": "k", "content-type": "application/json" }, body: "{}" });
  it("check-in and events routes are 404 while off", async () => {
    delete process.env.HUB_MODULES;
    process.env.CHECKIN_KEY = "k";
    expect((await checkinPost(post("http://localhost/api/checkin"))).status).toBe(404);
    expect((await checkinToday(new Request("http://localhost/api/checkin/today", { headers: { "x-checkin-key": "k" } }))).status).toBe(404);
    expect((await eventsPost(post("http://localhost/api/events"))).status).toBe(404);
  });
  it("checkins on does not open the events route", async () => {
    process.env.HUB_MODULES = "checkins";
    process.env.CHECKIN_KEY = "k";
    expect((await eventsPost(post("http://localhost/api/events"))).status).toBe(404);
    expect((await checkinPost(post("http://localhost/api/checkin"))).status).not.toBe(404);
  });
});

describe("Hevy is optional", () => {
  it("a Hevy sync with no client is skipped, not a crash", async () => {
    const { syncHevy, syncHevyWorkouts, syncHevyTemplates } = await import("@/core/hevy/sync");
    const deps = { sql: {} as never, hevy: null, timezone: "UTC" };
    expect(await syncHevy(deps)).toEqual([]);
    expect(await syncHevyWorkouts(deps)).toMatchObject({ ok: true, skipped: expect.stringMatching(/not set up/) });
    expect(await syncHevyTemplates(deps)).toMatchObject({ ok: true, skipped: expect.stringMatching(/not set up/) });
  });
  it("sync_now source hevy says Hevy isn't set up", async () => {
    const { syncNow } = await import("@/core/tools/sync");
    const out = await syncNow({ sql: {} as never, hevy: null, timezone: "UTC" }, null, "hevy");
    expect(out.hevy).toEqual({ skipped: expect.stringMatching(/HEVY_API_KEY is missing/) });
  });
  it("getConfig no longer requires a Hevy key, and carries the modules", async () => {
    const { getConfig } = await import("@/core/config");
    const cfg = getConfig({ DATABASE_URL: "postgres://u:p@h/d" });
    expect(cfg.hevyApiKey).toBeNull();
    expect([...cfg.modules]).toEqual([]);
    expect(() => getConfig({})).toThrow(/DATABASE_URL/);
  });
});
