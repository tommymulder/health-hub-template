import { describe, it, expect, vi } from "vitest";
import { createHevyWriter, HevyWriteError, type CustomExerciseBody, type RoutineBody, type WorkoutBody } from "@/core/hevy/write";

const body: RoutineBody = {
  title: "Heavy Lower", folder_id: 7, notes: null,
  exercises: [{ exercise_template_id: "D04AC939", superset_id: null, rest_seconds: 180, notes: null,
    sets: [{ type: "normal", weight_kg: 102.0582, reps: 3, duration_seconds: null }] }],
};
const res = (status: number, json: unknown = {}) => new Response(JSON.stringify(json), { status });

function writer(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const r = queue.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  return { fetchImpl, api: createHevyWriter({ apiKey: "k", fetchImpl: fetchImpl as never }) };
}
const call = (f: ReturnType<typeof writer>["fetchImpl"], n = 0) => f.mock.calls[n] as unknown as [URL, RequestInit];

describe("Hevy writer: request shapes", () => {
  it("POSTs a routine wrapped in {routine}, with the api-key and JSON content type", async () => {
    const { api, fetchImpl } = writer(res(201, { routine: { id: "r1" } }));
    const out = await api.createRoutine(body);
    const [url, init] = call(fetchImpl);
    expect(url.pathname).toBe("/v1/routines");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ routine: body });
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
    expect(out.raw).toEqual({ routine: { id: "r1" } });
  });
  it("PUTs an update to the routine's own URL", async () => {
    const { api, fetchImpl } = writer(res(200, { routine: { id: "r1" } }));
    await api.updateRoutine("r1", body);
    const [url, init] = call(fetchImpl);
    expect([init.method, url.pathname]).toEqual(["PUT", "/v1/routines/r1"]);
  });
  it("creates a folder with {routine_folder:{title}}", async () => {
    const { api, fetchImpl } = writer(res(201, { id: 42, title: "Claude" }));
    await api.createRoutineFolder("Claude");
    expect(JSON.parse(call(fetchImpl)[1].body as string)).toEqual({ routine_folder: { title: "Claude" } });
  });
  it("lists folders across pages", async () => {
    const { api } = writer(
      res(200, { page: 1, page_count: 2, routine_folders: [{ id: 1, title: "Push" }] }),
      res(200, { page: 2, page_count: 2, routine_folders: [{ id: 2, title: "Claude" }] }),
    );
    expect(await api.listRoutineFolders()).toEqual([{ id: 1, title: "Push" }, { id: 2, title: "Claude" }]);
  });
});

describe("Hevy writer: NEVER retries (no undo exists)", () => {
  it.each([429, 500, 503])("one attempt only on a %i", async (status) => {
    const { api, fetchImpl } = writer(res(status), res(201, { routine: { id: "dup" } }));
    await expect(api.createRoutine(body)).rejects.toBeInstanceOf(HevyWriteError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("one attempt only when the network drops", async () => {
    const { api, fetchImpl } = writer(new Error("ECONNRESET"), res(201, { routine: { id: "dup" } }));
    await expect(api.createRoutine(body)).rejects.toMatchObject({ unconfirmed: true, status: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Hevy writer: errors say what is known", () => {
  it("a 400 is a definite refusal (nothing was written)", async () => {
    const { api } = writer(res(400, { error: "bad set" }));
    await expect(api.createRoutine(body)).rejects.toMatchObject({ status: 400, unconfirmed: false, message: expect.stringContaining("bad set") });
  });
  it("a 403 explains the routine limit", async () => {
    const { api } = writer(res(403, { error: "Routine limit exceeded" }));
    await expect(api.createRoutine(body)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/limit/) });
  });
  it("a 404 on update says the routine is gone", async () => {
    const { api } = writer(res(404, { error: "nope" }));
    await expect(api.updateRoutine("r1", body)).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/deleted/) });
  });
  it("a 5xx on a write is UNCONFIRMED (the server may have acted before failing)", async () => {
    const { api } = writer(res(502));
    await expect(api.createRoutine(body)).rejects.toMatchObject({ status: 502, unconfirmed: true });
  });
  it("a failed read is never 'unconfirmed'", async () => {
    const { api } = writer(new Error("down"));
    await expect(api.getRoutine("r1")).rejects.toMatchObject({ unconfirmed: false });
  });
});

const workout: WorkoutBody = {
  title: "Example Gym - Strength", description: "board", start_time: "2026-07-22T14:02:00.000Z", end_time: "2026-07-22T15:00:00.000Z", is_private: false,
  exercises: [{ exercise_template_id: "79D0BB3A", superset_id: 0, notes: null, sets: [{ type: "normal", weight_kg: 61.2, reps: 8, duration_seconds: null, distance_meters: null, custom_metric: null, rpe: null }] }],
};
const custom: CustomExerciseBody = { title: "Hollow Hold", exercise_type: "duration", equipment_category: "none", muscle_group: "abdominals", other_muscles: [] };

describe("Hevy writer: workouts and custom exercises", () => {
  it("POSTs a finished workout wrapped in {workout}", async () => {
    const { api, fetchImpl } = writer(res(201, { workout: [{ id: "w1" }] }));
    const out = await api.createWorkout(workout);
    const [url, init] = call(fetchImpl);
    expect([init.method, url.pathname]).toEqual(["POST", "/v1/workouts"]);
    expect(JSON.parse(init.body as string)).toEqual({ workout });
    expect(out.raw).toEqual({ workout: [{ id: "w1" }] }); // the real reply is a ONE-ITEM ARRAY
  });
  it("POSTs a custom exercise wrapped in {exercise}", async () => {
    const { api, fetchImpl } = writer(res(200, { id: "ABC12345" }));
    await api.createExerciseTemplate(custom);
    const [url, init] = call(fetchImpl);
    expect([init.method, url.pathname]).toEqual(["POST", "/v1/exercise_templates"]);
    expect(JSON.parse(init.body as string)).toEqual({ exercise: custom });
  });
  it.each([429, 500, 503])("never retries a workout or custom exercise on a %i", async (status) => {
    for (const run of [(a: ReturnType<typeof writer>["api"]) => a.createWorkout(workout), (a: ReturnType<typeof writer>["api"]) => a.createExerciseTemplate(custom)]) {
      const { api, fetchImpl } = writer(res(status), res(200, { id: "dup" }));
      await expect(run(api)).rejects.toBeInstanceOf(HevyWriteError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("a 403 on a custom exercise names the custom-exercise limit", async () => {
    const { api } = writer(res(403, { error: "Exceeds custom exercise limit" }));
    await expect(api.createExerciseTemplate(custom)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/custom exercises/) });
  });
  it("a dropped connection while posting a workout is UNCONFIRMED", async () => {
    const { api } = writer(new Error("ECONNRESET"));
    await expect(api.createWorkout(workout)).rejects.toMatchObject({ unconfirmed: true });
  });
});
