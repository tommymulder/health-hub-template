import { describe, it, expect } from "vitest";
import { deriveFlag, isLoinc, labId, normFlag, normName, parseCollected, parseRef, parseValue } from "@/core/labs/norm";
import { canonUnit, convertValue, convertibleKind } from "@/core/labs/convert";

const TZ = "America/Los_Angeles";

describe("names, codes, values", () => {
  it("normalises lab names without the exercise aliases", () => {
    expect(normName("Cholesterol, Total")).toBe("cholesterol total");
    expect(normName("HDL-C (DB)")).toBe("hdl c db"); // 'db' must not become 'dumbbell'
  });
  it("recognises LOINC codes", () => {
    expect(isLoinc("2093-3")).toBe(true);
    expect(isLoinc("13457-7")).toBe(true);
    expect(isLoinc("cholesterol")).toBe(false);
    expect(isLoinc("2093")).toBe(false);
  });
  it("numbers are numbers; bounds and words stay text (a bound is not a measurement)", () => {
    expect(parseValue("5.4")).toEqual({ num: 5.4, text: null });
    expect(parseValue(5.4)).toEqual({ num: 5.4, text: null });
    expect(parseValue("<0.5")).toEqual({ num: null, text: "<0.5" });
    expect(parseValue(" Negative ")).toEqual({ num: null, text: "Negative" });
  });
  it("parses simple reference ranges and leaves the rest alone", () => {
    expect(parseRef("<200")).toEqual({ low: null, high: 200 });
    expect(parseRef(">=40")).toEqual({ low: 40, high: null });
    expect(parseRef("70-99")).toEqual({ low: 70, high: 99 });
    expect(parseRef("3.5 – 5.1")).toEqual({ low: 3.5, high: 5.1 });
    expect(parseRef("100-199 mg/dL")).toEqual({ low: 100, high: 199 });
    expect(parseRef("<200 mg/dL")).toEqual({ low: null, high: 200 });
    expect(parseRef(">40 mg/dL")).toEqual({ low: 40, high: null });
    expect(parseRef("0-15 mm/hr")).toEqual({ low: 0, high: 15 });
    expect(parseRef("Negative or trace")).toEqual({ low: null, high: null });
    expect(parseRef("Negative")).toEqual({ low: null, high: null });
    expect(parseRef(undefined)).toEqual({ low: null, high: null });
  });
});

describe("dates", () => {
  it("a date-only value keeps its date in the user's zone (local noon), through DST", () => {
    expect(parseCollected("2026-03-04", TZ)!.at.toISOString()).toBe("2026-03-04T20:00:00.000Z"); // PST, noon = 20:00Z
    expect(parseCollected("2026-10-04", TZ)!.at.toISOString()).toBe("2026-10-04T19:00:00.000Z"); // PDT, noon = 19:00Z
    expect(parseCollected("2026-03-04", TZ)!.dateOnly).toBe(true);
  });
  it("a full timestamp is the exact instant; garbage is rejected", () => {
    expect(parseCollected("2026-03-04T15:30:00Z", TZ)!.at.toISOString()).toBe("2026-03-04T15:30:00.000Z");
    expect(parseCollected("last tuesday", TZ)).toBeNull();
    expect(parseCollected("", TZ)).toBeNull();
  });
});

describe("flags", () => {
  it("maps the many spellings and keeps unknown ones null", () => {
    for (const f of ["H", "High", "high"]) expect(normFlag(f)).toBe("H");
    for (const f of ["L", "Low"]) expect(normFlag(f)).toBe("L");
    expect(normFlag("HH")).toBe("critical_high");
    expect(normFlag("N")).toBe("normal");
    expect(normFlag("A")).toBe("abnormal");
    expect(normFlag("???")).toBeNull();
    expect(normFlag(undefined)).toBeNull();
  });
  it("derives a flag only from a numeric value and a range", () => {
    expect(deriveFlag(210, null, 200)).toBe("H");
    expect(deriveFlag(60, 70, 99)).toBe("L");
    expect(deriveFlag(85, 70, 99)).toBe("normal");
    expect(deriveFlag(200, null, 200)).toBe("normal"); // on the limit is in range
    expect(deriveFlag(5, null, null)).toBeNull();
    expect(deriveFlag(null, 1, 2)).toBeNull();
  });
});

describe("ids", () => {
  it("same test, moment, value and source give the same id; any difference gives another", () => {
    const t = new Date("2026-03-04T20:00:00Z");
    expect(labId("Cholesterol, Total", t, 190, "s")).toBe(labId("cholesterol  total", t, "190", "s"));
    expect(labId("Cholesterol, Total", t, 190, "s")).not.toBe(labId("Cholesterol, Total", t, 191, "s"));
    expect(labId("Cholesterol, Total", t, 190, "s")).not.toBe(labId("Cholesterol, Total", t, 190, "other"));
  });
});

describe("unit conversions (only glucose and cholesterol)", () => {
  it("knows which tests are convertible", () => {
    expect(convertibleKind("Glucose", null)).toBe("glucose");
    expect(convertibleKind("Glucose, Fasting", "1558-6")).toBe("glucose");
    expect(convertibleKind("Cholesterol, Total", null)).toBe("cholesterol");
    expect(convertibleKind("LDL Cholesterol", null)).toBe("cholesterol");
    expect(convertibleKind("HDL", "2085-9")).toBe("cholesterol");
  });
  it("refuses look-alikes that are different quantities", () => {
    expect(convertibleKind("Triglycerides", null)).toBeNull();
    expect(convertibleKind("Cholesterol/HDL Ratio", null)).toBeNull();
    expect(convertibleKind("Hemoglobin A1c", null)).toBeNull();
    expect(convertibleKind("Glucose, Urine", null)).toBeNull();
    expect(convertibleKind("Estimated Average Glucose", null)).toBeNull();
    expect(convertibleKind("Testosterone", null)).toBeNull();
  });
  it("converts mg/dL <-> mmol/L with the right factors", () => {
    expect(convertValue("glucose", 99, "mg/dL", "mmol/L")!).toBeCloseTo(5.495, 2);
    expect(convertValue("glucose", 5.5, "mmol/L", "mg/dL")!).toBeCloseTo(99.1, 1);
    expect(convertValue("cholesterol", 200, "mg/dL", "mmol/L")!).toBeCloseTo(5.17, 2);
    expect(convertValue("cholesterol", 5.2, "mmol/L", "mg/dL")!).toBeCloseTo(201.1, 1);
    expect(convertValue("cholesterol", 200, "mg/dL", "mg/dL")).toBe(200);
  });
  it("treats unit spellings as one unit", () => {
    expect(canonUnit("mg/dL (calc)")).toBe(canonUnit(" MG/DL "));
    expect(canonUnit("mmol/L")).not.toBe(canonUnit("mg/dL"));
    expect(convertValue("cholesterol", 110, "mg/dL (calc)", "mmol/L")!).toBeCloseTo(2.84, 2);
  });
  it("returns null for any other unit pair instead of guessing", () => {
    expect(convertValue("glucose", 5, "g/L", "mg/dL")).toBeNull();
    expect(convertValue("cholesterol", 5, "mg/dL", "g/L")).toBeNull();
  });
});
