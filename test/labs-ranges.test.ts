import { describe, it, expect } from "vitest";
import { createRangeBook, OPTIMAL_RANGES, optimalBand, type OptimalRange } from "@/core/labs/ranges";

// Made-up bands that exercise every rule of the matcher. The shipped list holds one example only (see ranges.ts).
const spec = (r: Partial<OptimalRange> & Pick<OptimalRange, "unit" | "optLow" | "optHigh">): OptimalRange =>
  ({ loinc: [], names: [], under: "below_optimal", ...r });

const book = createRangeBook([
  spec({ loinc: ["1000-1"], names: ["Test Sugar", "Fasting Sugar"], unit: "mg/dl", optLow: 75, optHigh: 86, lowBelow: 65, aboveUntil: 99 }),
  spec({ loinc: ["1001-9"], names: ["Test Cell Count"], unit: "thousand", optLow: 1.9, optHigh: 4.2, lowBelow: 1.5, aboveUntil: 7.8 }),
  spec({ loinc: ["1002-7"], names: ["Test Hormone"], unit: "tsh", optLow: 1, optHigh: 2.5, under: "low" }),
  spec({ loinc: ["1003-5"], names: ["Test Enzyme"], unit: "enzyme", optLow: 10, optHigh: 30, under: "low" }),
  spec({ loinc: ["1004-3"], names: ["Test Ratio"], unit: "ratio", optLow: 10, optHigh: 16, under: "below_optimal" }),
  spec({ loinc: ["1005-0"], names: ["Test Filtration"], unit: "egfr", optLow: 90, optHigh: 160, lowBelow: 60, under: "below_optimal" }),
]);

describe("optimal range bands", () => {
  const sugar = book.range("1000-1", "Test Sugar", "mg/dL")!;
  it("walks low, below_optimal, optimal, above_optimal, high", () => {
    expect(optimalBand(60, sugar)).toBe("low");
    expect(optimalBand(70, sugar)).toBe("below_optimal");
    expect(optimalBand(75, sugar)).toBe("optimal");
    expect(optimalBand(86, sugar)).toBe("optimal");
    expect(optimalBand(97, sugar)).toBe("above_optimal");
    expect(optimalBand(100, sugar)).toBe("high");
  });
  it("a range without lowBelow or aboveUntil goes straight to its outer label", () => {
    const hormone = book.range("1002-7", "Test Hormone", "mIU/L")!;
    expect(optimalBand(0.5, hormone)).toBe("low");
    expect(optimalBand(3, hormone)).toBe("high");
  });
});

describe("matching a result to a range", () => {
  it("matches by LOINC, and by name only when the result has no LOINC", () => {
    expect(book.range("1000-1", "anything", "mg/dL")).not.toBeNull();
    expect(book.range(null, "Fasting Sugar", "mg/dL")).not.toBeNull();
    expect(book.range(null, "fasting   SUGAR", "mg/dL")).not.toBeNull(); // spelling and case
  });
  it("a LOINC that is not listed never falls through to the name", () => {
    // Same name, different test (a urine count shares the blood count's name): must not inherit the blood band.
    expect(book.range("9999-9", "Test Sugar", "mg/dL")).toBeNull();
  });
  it("does not apply a range when the unit is a different scale", () => {
    // cells/uL is 1000x k/cumm: a band of 1.9-4.2 would call 2990 "high".
    expect(book.range("1001-9", "Test Cell Count", "cells/uL")).toBeNull();
    expect(book.range("1001-9", "Test Cell Count", "10*3/uL")).not.toBeNull();
    expect(book.range("1001-9", "Test Cell Count", "x10E3/uL")).not.toBeNull();
    expect(book.range("1000-1", "Test Sugar", "mmol/L")).toBeNull();
  });
  it("treats equivalent spellings as the same unit", () => {
    expect(book.range("1002-7", "Test Hormone", "uIU/mL")).not.toBeNull();
    expect(book.range("1002-7", "Test Hormone", "u[iU]/mL")).not.toBeNull();
    expect(book.range("1003-5", "Test Enzyme", "U/L")).not.toBeNull();
    expect(book.range("1003-5", "Test Enzyme", "[IU]/L")).not.toBeNull();
    expect(book.range("1005-0", "Test Filtration", "mL/min/{1.73_m2}")).not.toBeNull();
    expect(book.range("1004-3", "Test Ratio", null)).not.toBeNull();
  });
});

describe("a range list", () => {
  it("refuses a LOINC or a name listed twice", () => {
    expect(() => createRangeBook([spec({ loinc: ["1-1"], unit: "mg/dl", optLow: 1, optHigh: 2 }), spec({ loinc: ["1-1"], unit: "mg/dl", optLow: 1, optHigh: 2 })])).toThrow(/LOINC 1-1 listed twice/);
    expect(() => createRangeBook([spec({ names: ["Same"], unit: "mg/dl", optLow: 1, optHigh: 2 }), spec({ names: ["same"], unit: "mg/dl", optLow: 1, optHigh: 2 })])).toThrow(/listed twice/);
  });
  it("the shipped list is one made-up example, valid", () => {
    expect(OPTIMAL_RANGES.length).toBeLessThanOrEqual(1);
    const codes = OPTIMAL_RANGES.flatMap((r) => r.loinc);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of OPTIMAL_RANGES) expect(r.optLow).toBeLessThanOrEqual(r.optHigh);
  });
});
