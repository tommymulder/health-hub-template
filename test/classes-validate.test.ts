import { describe, it, expect } from "vitest";
import { validateClassInput } from "@/core/classes/validate";
import type { ClassInput } from "@/core/classes/types";

const ok = (): ClassInput => ({
  gym: "Example Gym", class_type: "strength", board_text: "A) ...", precision: "exact",
  blocks: [{ label: "A", format: "sets", sets: { min: 3, max: 4 }, sets_done: 3, movements: [{ movement: "barbell bench press", target: { reps: 8 }, done_sets: [{ reps: 8, weight: 135 }] }] }],
});

describe("validateClassInput", () => {
  it("accepts a good submission", () => expect(validateClassInput(ok())).toEqual([]));
  it("reports every problem at once", () => {
    const bad = ok();
    bad.gym = " "; (bad as any).class_type = "yoga"; bad.board_text = ""; bad.completion_pct = 120; bad.duration_min = 2;
    bad.blocks[0].format = "weird" as never; bad.blocks[0].sets = { min: 5, max: 3 }; bad.blocks[0].sets_done = 2.5;
    bad.blocks[0].movements[0].done_sets = [{ reps: 0, weight: -5 }, { type: "bogus" as never }, { duration_s: 0 }];
    const p = validateClassInput(bad).join(" | ");
    for (const re of [/gym is required/, /class_type must/, /board_text is required/, /completion_pct/, /duration_min/, /format must/, /min <= max/, /sets_done/,
      /set 1: reps must/, /set 1: weight must/, /set 2: type must/, /set 3: duration_s/]) expect(p).toMatch(re);
  });
  it("needs at least one block and one movement per block, each with a target", () => {
    expect(validateClassInput({ ...ok(), blocks: [] })).toEqual(["at least one block is required."]);
    const b = ok(); b.blocks[0].movements = [];
    expect(validateClassInput(b).join()).toMatch(/at least one movement/);
    const t = ok(); (t.blocks[0].movements[0] as any).target = undefined;
    expect(validateClassInput(t).join()).toMatch(/target .* is required/);
  });
  it("a set with no reps, duration or distance is rejected", () => {
    const b = ok(); b.blocks[0].movements[0].done_sets = [{ weight: 100 }];
    expect(validateClassInput(b).join()).toMatch(/needs reps, duration_s or distance_m/);
  });
  it("weights are checked in the convenience form too", () => {
    const b = ok(); b.blocks[0].movements[0].weight = [135, -1];
    expect(validateClassInput(b).join()).toMatch(/weight must be between/);
  });
});

describe("Phase 19 input fields: total, share, optional, calories, finish_s", () => {
  const withTarget = (t: Record<string, unknown>) => { const b = ok(); Object.assign(b.blocks[0].movements[0].target, t); return b; };
  it("accepts the new fields when they are valid", () => {
    const b = ok();
    Object.assign(b.blocks[0].movements[0].target, { total: true, share: 0.5, optional: true, calories: 15 });
    b.blocks[0].movements[0].done_sets = [{ reps: 20, calories: 14 }];
    b.blocks[0].finish_s = 540;
    expect(validateClassInput(b)).toEqual([]);
  });
  it("share must be above 0 and at most 1", () => {
    for (const share of [0, -0.5, 1.5, "half"]) expect(validateClassInput(withTarget({ share })).join(), String(share)).toMatch(/share must be/);
    expect(validateClassInput(withTarget({ share: 1 }))).toEqual([]);
  });
  it("total and optional must be true or false", () => {
    expect(validateClassInput(withTarget({ total: "yes" })).join()).toMatch(/total must be true or false/);
    expect(validateClassInput(withTarget({ optional: 1 })).join()).toMatch(/optional must be true or false/);
  });
  it("calories (target or done set) are a plain positive number up to 5000", () => {
    for (const calories of [0, -3, 6000, "ten"]) expect(validateClassInput(withTarget({ calories })).join(), String(calories)).toMatch(/target\.calories must be/);
    const b = ok(); b.blocks[0].movements[0].done_sets = [{ reps: 5, calories: 0 }];
    expect(validateClassInput(b).join()).toMatch(/set 1: calories must be/);
  });
  it("finish_s is whole seconds", () => {
    const b = ok(); b.blocks[0].finish_s = 0;
    expect(validateClassInput(b).join()).toMatch(/finish_s must be whole seconds/);
    b.blocks[0].finish_s = 90.5;
    expect(validateClassInput(b).join()).toMatch(/finish_s must be whole seconds/);
  });
  it("a set with only calories is still not enough for Hevy: it needs reps, a time or a distance", () => {
    const b = ok(); b.blocks[0].movements[0].done_sets = [{ calories: 12 }];
    expect(validateClassInput(b).join()).toMatch(/needs reps, duration_s or distance_m/);
  });
});
