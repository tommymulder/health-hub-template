import { describe, it, expect } from "vitest";
import { parseHaePayload, parseHaeDate, normalizeUnit, sourceName, isOuraSource } from "@/core/apple/parse";
import body from "./fixtures/apple-health/body.json";
import other from "./fixtures/apple-health/other.json";
import workouts from "./fixtures/apple-health/workouts.json";

const TZ = "America/Los_Angeles";

describe("parseHaeDate", () => {
  it("uses the offset in the string: same instant whatever the zone", () => {
    expect(parseHaeDate("2026-10-10 09:57:54 -0700", TZ)!.toISOString()).toBe("2026-10-10T16:57:54.000Z");
    expect(parseHaeDate("2026-12-10 09:57:54 -0800", TZ)!.toISOString()).toBe("2026-12-10T17:57:54.000Z");
  });
  it("handles the day DST ends (offset changes inside one day)", () => {
    expect(parseHaeDate("2026-11-01 00:30:00 -0700", TZ)!.toISOString()).toBe("2026-11-01T07:30:00.000Z");
    expect(parseHaeDate("2026-11-01 03:30:00 -0800", TZ)!.toISOString()).toBe("2026-11-01T11:30:00.000Z");
  });
  it("treats a date-only value as local midnight", () => {
    expect(parseHaeDate("2026-10-10", TZ)!.toISOString()).toBe("2026-10-10T07:00:00.000Z");
    expect(parseHaeDate("2026-12-10", TZ)!.toISOString()).toBe("2026-12-10T08:00:00.000Z");
  });
  it("returns null for garbage rather than a wrong date", () => {
    expect(parseHaeDate("yesterday", TZ)).toBeNull();
    expect(parseHaeDate(undefined, TZ)).toBeNull();
  });
});

describe("units", () => {
  it("kJ becomes kcal, lb becomes kg, everything else is untouched", () => {
    expect(normalizeUnit(41.84, "kJ")).toEqual({ value: 10, unit: "kcal" });
    expect(normalizeUnit(100, "lb").unit).toBe("kg");
    expect(normalizeUnit(100, "lb").value).toBeCloseTo(45.359237, 6);
    expect(normalizeUnit(5, "km")).toEqual({ value: 5, unit: "km" });
    expect(normalizeUnit(null, "kJ")).toEqual({ value: null, unit: "kJ" });
  });
});

describe("sources and Oura (D12)", () => {
  it("reads names from strings, objects and JSON text", () => {
    expect(sourceName("Scale App")).toBe("Scale App");
    expect(sourceName({ name: "Hevy", identifier: "com.hevyapp.hevy" })).toBe("Hevy");
    expect(sourceName('{"name": "Oura", "identifier": "x"}')).toBe("Oura");
    expect(sourceName(undefined)).toBe("");
  });
  it("recognises Oura by name or bundle id, and nothing else", () => {
    expect(isOuraSource("Oura")).toBe(true);
    expect(isOuraSource({ name: "Ring", identifier: "com.ouraring.oura" })).toBe(true);
    expect(isOuraSource("Scale App")).toBe(false);
    expect(isOuraSource("")).toBe(false);
    expect(isOuraSource(undefined)).toBe(false);
  });
});

describe("body metrics payload (real shape)", () => {
  const r = parseHaePayload(body, TZ);
  it("keeps every source: the scale and Hevy's separate entry", () => {
    const w = r.samples.filter((s) => s.metric === "weight_body_mass");
    expect(w.map((s) => s.source).sort()).toEqual(["Hevy", "Scale App", "Scale App"]);
    expect(w.every((s) => s.unit === "kg")).toBe(true);
  });
  it("keeps full precision (rounding happens only when shown)", () => {
    const s = r.samples.find((x) => x.source === "Scale App" && x.metric === "weight_body_mass")!;
    expect(s.value).toBe(80.123456789);
    expect(s.start_at.toISOString()).toBe("2026-10-06T15:43:00.000Z");
    expect(s.end_at).toBeNull(); // end == start carries no information
  });
  it("body fat stays in percent and BMI as a count", () => {
    expect(r.samples.find((s) => s.metric === "body_fat_percentage")).toMatchObject({ value: 20.5, unit: "%" });
    expect(r.samples.find((s) => s.metric === "body_mass_index")).toMatchObject({ value: 25.1, unit: "count" });
  });
});

describe("other metrics payload (real shape)", () => {
  const r = parseHaePayload(other, TZ);
  it("converts energy to kcal", () => {
    const e = r.samples.filter((s) => s.metric === "active_energy");
    expect(e.map((s) => [s.value, s.unit])).toEqual([[10, "kcal"], [20, "kcal"]]);
  });
  it("sourceless points get an empty source and two points at one minute collapse to one row (last wins)", () => {
    const steps = r.samples.filter((s) => s.metric === "step_count");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ value: 14, source: "" });
  });
  it("drops Oura-sourced points and counts them", () => {
    expect(r.samples.some((s) => s.source === "Oura")).toBe(false);
    expect(r.droppedOura).toBe(2); // the Oura distance and the Oura heart-rate point
  });
  it("Min/Avg/Max metrics store Avg as value with min and max", () => {
    expect(r.samples.find((s) => s.metric === "heart_rate")).toMatchObject({ value: 70, min: 58, max: 90, source: "Test Watch" });
  });
  it("blood pressure keeps the second number in extra", () => {
    const bp = r.samples.find((s) => s.metric === "blood_pressure")!;
    expect(bp.value).toBe(118);
    expect(bp.extra).toEqual({ systolic: 118, diastolic: 76 });
  });
  it("an unknown shape is skipped and counted, never invented", () => {
    expect(r.skipped).toEqual({ mystery_metric: 1 });
  });
});

describe("workouts payload (real shape)", () => {
  const r = parseHaePayload(workouts, TZ);
  it("drops the Oura workout and keeps Hevy's and the others", () => {
    expect(r.droppedOura).toBe(1);
    expect(r.workouts.map((w) => w.source).sort()).toEqual(["Hevy", "Test Watch"]);
  });
  it("keeps the HAE id, or hashes name+times+source when there is none (stable across runs)", () => {
    const hevy = r.workouts.find((w) => w.source === "Hevy")!;
    expect(hevy.id).toBe("BBBBBBBB-0000-0000-0000-000000000002");
    const a = parseHaePayload(workouts, TZ).workouts.find((w) => w.source === "Test Watch")!;
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.id).toBe(r.workouts.find((w) => w.source === "Test Watch")!.id);
  });
  it("strips the big series, keeps the rest, and adds kcal", () => {
    const hevy = r.workouts.find((w) => w.source === "Hevy")!;
    expect(hevy.data.route).toBeUndefined();
    expect(hevy.data.heartRateData).toBeUndefined();
    expect(hevy.data.isIndoor).toBe(true);
    expect(hevy.data.active_kcal as number).toBeCloseTo(25.44 / 4.184, 6);
    expect(hevy.start_at.toISOString()).toBe("2026-10-11T07:48:37.000Z");
  });
});

describe("robustness", () => {
  it("never throws on junk", () => {
    for (const j of [null, undefined, 5, "x", [], {}, { data: null }, { data: { metrics: "no" } }, { data: { metrics: [null, 3, { name: 5 }] } }]) {
      expect(() => parseHaePayload(j, TZ)).not.toThrow();
    }
  });
});
