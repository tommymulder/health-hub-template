import { describe, it, expect, beforeAll } from "vitest";

// Exercises the real route wiring: which header is read, and what happens without it.
const url = "http://localhost/api/mcp";
const base = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
let POST: (req: Request) => Promise<Response> | Response;

beforeAll(async () => {
  process.env.MCP_SECRET = "test-secret";
  process.env.HEVY_API_KEY = "test-hevy"; // the full tool list: Hevy and every optional module on (the module switch has its own test)
  process.env.HUB_MODULES = "checkins,classes,genetics,events";
  ({ POST } = await import("../app/api/mcp/route"));
});

const call = (headers: Record<string, string>) =>
  POST(new Request(url, { method: "POST", headers: { ...base, ...headers }, body }));

describe("POST /api/mcp auth", () => {
  it("401 with no key", async () => expect((await call({})).status).toBe(401));
  it("401 with a wrong key", async () =>
    expect((await call({ "x-api-key": "nope" })).status).toBe(401));
  it("401 when the old X-Hub-Key header is used", async () =>
    expect((await call({ "x-hub-key": "test-secret" })).status).toBe(401));
  it("200 and lists ping with the right x-api-key", async () => {
    const res = await call({ "x-api-key": "test-secret" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"name":"ping"');
  });
});

describe("POST /api/mcp tool list", () => {
  it("advertises the routine tools with the right safety annotations", async () => {
    const res = await call({ "x-api-key": "test-secret" });
    const text = await res.text();
    const data = JSON.parse(text.split("data: ")[1]);
    const tools = Object.fromEntries(data.result.tools.map((t: { name: string }) => [t.name, t]));
    for (const name of ["ping", "sync_now", "get_sync_status", "get_recent_workouts", "get_workout_details",
      "get_exercise_progress", "get_training_summary", "search_exercises", "create_routine", "update_routine",
      "get_recovery", "get_oura_data", "get_heart_rate", "connect_oura", "log_class_workout", "get_class_history"]) {
      expect(tools[name], name).toBeDefined();
    }
    expect(tools.create_routine.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.update_routine.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.create_routine.description).toMatch(/explicitly confirmed/);
    expect(tools.create_routine.description).toMatch(/NO delete/);
    expect(tools.get_recent_workouts.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get_recovery.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get_class_history.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.log_class_workout.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false }); // a writer: must land in the approval group
    expect(tools.log_class_workout.description).toMatch(/ALWAYS call with dry_run: true first/);
    expect(tools.log_class_workout.description).toMatch(/NO delete/);
    expect(tools.log_class_workout.inputSchema.required).toEqual(expect.arrayContaining(["gym", "class_type", "board_text", "blocks", "precision"]));
    expect(tools.get_oura_data.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get_heart_rate.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.log_event.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false }); // a writer (so "Needs approval"), and hiding is reversible
    expect(tools.log_event.inputSchema.properties.type.enum).toEqual(["bathroom"]);
    expect(tools.log_event.description).toMatch(/forgot/);
    expect(tools.log_lab_results.inputSchema.properties.results.items.properties.dexa).toBeDefined();
    expect(tools.log_lab_results.annotations).toMatchObject({ readOnlyHint: false }); // still a writer: stays in the approval group
    expect(tools.get_heart_rate.inputSchema.properties.group_by.enum).toEqual(["none", "hour", "day", "week"]);
    expect(tools.connect_oura.annotations).toMatchObject({ readOnlyHint: false }); // writes a one-time state row, so it must not be auto-approved as read-only
    expect(tools.get_oura_data.inputSchema.properties.collection.enum).toEqual(expect.arrayContaining(["sleep", "daily_readiness", "workout", "vO2_max"]));
    expect(tools.create_routine.inputSchema.required).toEqual(expect.arrayContaining(["title", "exercises"]));
  });
});


const rpc = async (method: string, params?: object) => {
  const res = await POST(new Request(url, { method: "POST", headers: { ...base, "x-api-key": "test-secret" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  expect(res.status).toBe(200);
  return JSON.parse((await res.text()).split("data: ")[1]);
};

describe("POST /api/mcp: Phases 7-9", () => {
  it("lists the Apple Health, lab and trend tools with honest safety labels", async () => {
    const tools = Object.fromEntries((await rpc("tools/list")).result.tools.map((t: { name: string }) => [t.name, t]));
    for (const name of ["get_body_metrics", "list_health_types", "get_health_data", "exclude_apple_sample", "get_lab_results", "log_lab_results", "get_trends"]) expect(tools[name], name).toBeDefined();
    for (const name of ["get_body_metrics", "list_health_types", "get_health_data", "get_lab_results", "get_trends"]) expect(tools[name].annotations, name).toMatchObject({ readOnlyHint: true });
    // writers must land in the connector's approval group: never labelled read-only
    for (const name of ["exclude_apple_sample", "log_lab_results"]) expect(tools[name].annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.log_lab_results.description).toMatch(/dry_run: true first/);
    expect(tools.get_lab_results.description).toMatch(/NOT a doctor/);
    expect(tools.get_lab_results.description).toMatch(/reported_by/);
    for (const name of ["get_genetics", "log_genetic_variants"]) expect(tools[name], name).toBeDefined();
    expect(tools.get_genetics.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.log_genetic_variants.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tools.log_genetic_variants.description).toMatch(/wait for a yes before calling/);
    expect(tools.log_genetic_variants.description).toMatch(/Never invent an rsID/);
    expect(tools.get_genetics.description).toMatch(/not diagnoses/);
    for (const name of ["get_checkins", "get_feel_vs_ring"]) expect(tools[name].annotations, name).toMatchObject({ readOnlyHint: true });
    expect(tools.log_checkin.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tools.log_checkin.description).toMatch(/How did you feel when you woke up/);
    expect(tools.log_checkin.description).toMatch(/do not show the Oura sleep score/);
    expect(tools.get_feel_vs_ring.description).toMatch(/too early/);
    expect(tools.sync_now.inputSchema.properties.source.enum).toEqual(expect.arrayContaining(["hevy", "oura", "apple", "all"]));
  });

  it("the overlapping tools point at each other", async () => {
    const tools = Object.fromEntries((await rpc("tools/list")).result.tools.map((t: { name: string }) => [t.name, t]));
    for (const name of ["get_recovery", "get_body_metrics", "get_training_summary"]) expect(tools[name].description, name).toMatch(/get_trends/);
  });

  it("serves the three coach prompts, with the arguments filled in", async () => {
    const list = (await rpc("prompts/list")).result.prompts.map((p: { name: string }) => p.name);
    expect(list).toEqual(expect.arrayContaining(["plan_workout", "log_class", "weekly_review"]));
    const plan = (await rpc("prompts/get", { name: "plan_workout", arguments: { minutes: "30", focus: "heavy lower" } })).result.messages[0].content.text;
    expect(plan).toMatch(/30 minutes/);
    expect(plan).toMatch(/heavy lower/);
    expect(plan).toMatch(/WAIT for my yes/);
    expect(plan).toMatch(/get_recovery[\s\S]*get_trends/);
    const cls = (await rpc("prompts/get", { name: "log_class", arguments: {} })).result.messages[0].content.text;
    expect(cls).toMatch(/dry_run true/);
    expect(cls).toMatch(/Never invent a weight/);
    const review = (await rpc("prompts/get", { name: "weekly_review", arguments: { weeks: "6" } })).result.messages[0].content.text;
    expect(review).toMatch(/last 6 weeks/);
  });
});

describe("Coach project instructions (docs/coach-instructions.txt)", () => {
  const read = async () => (await import("node:fs")).readFileSync("docs/coach-instructions.txt", "utf8");

  it("only name tools that exist", async () => {
    const text = await read();
    const real = new Set((await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name));
    const named = [...new Set([...text.matchAll(/\b((?:get|log|create|update|search|sync|list|exclude|connect)_[a-z_]+)\b/g)].map((m) => m[1]))];
    expect(named.length).toBeGreaterThan(8);
    for (const n of named) expect(real.has(n), `${n} is not a real tool`).toBe(true);
  });

  it("is plain text: the project's instructions box drops bullets, numbered lists and markdown, so none may appear", async () => {
    const lines = (await read()).split("\n");
    for (const [i, l] of lines.entries()) {
      expect(/^\s*([-*\u2022]|\d+[.)]|#)\s/.test(l), `line ${i + 1} starts like a list or heading: ${l.slice(0, 40)}`).toBe(false);
    }
    expect(/[`*]|\*\*|^\s*\|/m.test(await read())).toBe(false);
  });
});
