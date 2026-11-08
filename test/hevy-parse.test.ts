import { describe, it, expect } from "vitest";
import { parseWorkout } from "@/core/hevy/parse";
import type { HevyWorkout } from "@/core/hevy/types";
import fixture from "./fixtures/hevy/workout.json";

const w = fixture as unknown as HevyWorkout;

describe("parseWorkout", () => {
  const { workout, exercises } = parseWorkout(w, "America/Los_Angeles");

  it("maps the workout row and derives the local date", () => {
    expect(workout).toMatchObject({
      id: "test-w1", title: "Heavy Lower",
      start_at: "2026-11-01T08:30:00Z", end_at: "2026-11-01T09:20:00Z",
      local_date: "2026-11-01", hevy_updated_at: "2026-11-01T09:21:00Z",
    });
  });

  it("keeps weights in kg, unconverted", () => {
    expect(exercises[0].sets[0].weight_kg).toBe(61.235);
    expect(exercises[0].sets[1]).toMatchObject({ weight_kg: 102.058, reps: 3, rpe: 8.5, set_type: "normal" });
  });

  it("maps durations, supersets, and nulls", () => {
    expect(exercises[1]).toMatchObject({ superset_id: 1, notes: null, exercise_title: "Plank" });
    expect(exercises[1].sets[0]).toMatchObject({ duration_s: 60, weight_kg: null, reps: null });
  });

  it("tolerates a workout with no exercises", () => {
    expect(parseWorkout({ ...w, exercises: [] }, "UTC").exercises).toEqual([]);
  });
});

describe("parseWorkout: CSV-import time correction", () => {
  const imported = { ...w, created_at: "BATCH", start_time: "2026-03-30T05:30:00Z", end_time: "2026-03-30T06:20:00Z" };
  const batches = new Set(["BATCH"]);

  it("reinterprets the UTC-labelled clock as local time for a listed batch", () => {
    const { workout } = parseWorkout(imported, "America/Los_Angeles", batches);
    expect(workout.start_at).toBe("2026-03-30T12:30:00.000Z");
    expect(workout.end_at).toBe("2026-03-30T13:20:00.000Z");
    expect(workout.local_date).toBe("2026-03-30"); // not the 29th
  });
  it("leaves unlisted workouts (logged natively in Hevy) untouched", () => {
    const { workout } = parseWorkout({ ...imported, created_at: "OTHER" }, "America/Los_Angeles", batches);
    expect(workout.start_at).toBe("2026-03-30T05:30:00Z");
    expect(workout.local_date).toBe("2026-03-29");
  });
  it("does nothing when no batches are configured", () => {
    expect(parseWorkout(imported, "America/Los_Angeles").workout.start_at).toBe("2026-03-30T05:30:00Z");
  });
});
