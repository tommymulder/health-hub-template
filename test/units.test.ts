import { describe, it, expect } from "vitest";
import { kgToLb, lbToKg, outWeight } from "@/core/units";

describe("units", () => {
  it("uses the exact definition 1 lb = 0.45359237 kg", () => {
    expect(lbToKg(1)).toBe(0.45359237);
    expect(lbToKg(100)).toBeCloseTo(45.359237, 10);
  });

  it("225 lb round-trips to exactly 225 with no rounding in between", () => {
    expect(kgToLb(lbToKg(225))).toBeCloseTo(225, 10);
    expect(outWeight(lbToKg(225), "lb")).toBe(225);
  });

  it("shows imported 135 / 185 / 205 lb weights cleanly from 4-decimal kg", () => {
    // a corrected CSV import stores kg to 4 decimals
    expect(outWeight(61.235, "lb")).toBe(135);
    expect(outWeight(83.9146, "lb")).toBe(185);
    expect(outWeight(92.9864, "lb")).toBe(205);
  });

  it("converts the known mix-up exactly: 135 'kg' displays as 297.6 lb", () => {
    expect(outWeight(135, "lb")).toBe(297.6);
  });

  it("passes kg through and keeps null", () => {
    expect(outWeight(102.058, "kg")).toBe(102.1);
    expect(outWeight(null, "lb")).toBeNull();
  });
});
