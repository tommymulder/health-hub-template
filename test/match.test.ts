import { describe, it, expect } from "vitest";
import { rankExercises, scoreTitle } from "@/core/match";

const items = [
  { title: "Bench Press (Barbell)", sessions: 38 },
  { title: "Bench Press (Dumbbell)", sessions: 27 },
  { title: "Incline Bench Press (Barbell)", sessions: 12 },
  { title: "Romanian Deadlift (Barbell)", sessions: 26 },
  { title: "Deadlift (Barbell)", sessions: 27 },
  { title: "Squat (Barbell)", sessions: 10 },
  { title: "Goblet Squat", sessions: 0 },
  { title: "Overhead Press (Barbell)", sessions: 17 },
  { title: "Triceps Pushdown", sessions: 19 },
];
const top = (q: string) => rankExercises(q, items).map((r) => r.item.title);

describe("exercise name matching", () => {
  it("'bench press' picks the barbell version over the incline one, using usage to break the tie with dumbbell", () => {
    expect(top("bench press").slice(0, 3)).toEqual([
      "Bench Press (Barbell)", "Bench Press (Dumbbell)", "Incline Bench Press (Barbell)",
    ]);
  });
  it("'bench' alone still prefers the plain bench press", () => expect(top("bench")[0]).toBe("Bench Press (Barbell)"));
  it("is case- and punctuation-insensitive; exact title wins outright", () => {
    expect(top("BENCH PRESS (BARBELL)")[0]).toBe("Bench Press (Barbell)");
    expect(scoreTitle("Squat (Barbell)", "Squat (Barbell)")).toBe(1000);
  });
  it("understands common shorthand", () => {
    expect(top("rdl")[0]).toBe("Romanian Deadlift (Barbell)");
    expect(top("ohp")[0]).toBe("Overhead Press (Barbell)");
  });
  it("tolerates plurals and a typo", () => {
    expect(top("squats")[0]).toBe("Squat (Barbell)");
    expect(top("tricep pushdown")[0]).toBe("Triceps Pushdown");
    expect(top("deadlfit")).not.toContain("Squat (Barbell)");
  });
  it("'deadlift' prefers the plain lift over the Romanian one", () => expect(top("deadlift")[0]).toBe("Deadlift (Barbell)"));
  it("returns nothing for a non-match or empty query", () => {
    expect(top("zzzz")).toEqual([]);
    expect(top("")).toEqual([]);
  });
});
