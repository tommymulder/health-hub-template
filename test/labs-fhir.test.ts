import { describe, it, expect } from "vitest";
import { parseClinicalRecords } from "@/core/labs/fhir";
import { convertValue } from "@/core/labs/convert";
import records from "./fixtures/fhir/records.json";

const TZ = "America/Los_Angeles";
const parsed = parseClinicalRecords(records, TZ);
const by = (id: string) => parsed.results.find((r) => r.id === id)!;

describe("FHIR clinical records (shapes from a real export)", () => {
  it("reads standalone observations: value, unit, range, LOINC, exact time", () => {
    const r = by("fhir:shortid0000000000000a");
    expect(r).toMatchObject({ test_name: "PROLACTIN", loinc_code: "2842-3", value_num: 12.5, unit: "ng/mL", ref_low: 4, ref_high: 15, value_text: null });
    expect(r.collected_at.toISOString()).toBe("2026-04-06T15:15:00.000Z"); // 08:15 -07:00
  });
  it("reads a range given only as text", () => {
    const r = by("fhir:shortid0000000000000b");
    expect(r).toMatchObject({ ref_low: 3.9, ref_high: 5.5, ref_text: "3.9-5.5 mmol/L", unit: "mmol/L" });
  });
  it("string results stay text; a comparator makes a bound, not a measurement", () => {
    expect(by("fhir:uuid-style-0000-0000-0000-00000000000c")).toMatchObject({ value_num: null, value_text: "Negative", ref_text: "Negative", loinc_code: "5770-3" });
    expect(by("fhir:uuid-style-0000-0000-0000-00000000000d")).toMatchObject({ value_num: null, value_text: "<0.5", unit: "ng/mL" });
  });
  it("keeps the original unit text but a calc'd mg/dL still converts", () => {
    const r = by("fhir:hosp-obs-0000000000000000000000000000000000000000000000000000001");
    expect(r.unit).toBe("mg/dL (calc)");
    expect(r.ref_high).toBe(100);
    expect(convertValue("cholesterol", 110, r.unit, "mmol/L")!).toBeCloseTo(2.84, 2);
  });
  it("Lab results nested in a DiagnosticReport are found, with the lab's own flag, the report's date and panel", () => {
    const chol = by("fhir:lc-report-0001/c1");
    expect(chol).toMatchObject({ test_name: "Cholesterol, Total", loinc_code: "2093-3", value_num: 212, flag: "H", panel: "Lipid Panel", performer: "LabCorp", ref_low: 100, ref_high: 199 });
    const hdl = by("fhir:lc-report-0001/c2");
    expect(hdl.flag).toBe("normal");
    expect(hdl.collected_at.toISOString()).toBe("2022-08-16T17:30:00.000Z"); // no date of its own: the report's
    expect(by("fhir:lc-report-0001/c3")).toMatchObject({ value_text: "Clear", loinc_code: null });
  });
  it("panel names come from the DiagnosticReport that lists the result; generic titles are ignored", () => {
    expect(by("fhir:uuid-style-0000-0000-0000-00000000000c").panel).toBeNull(); // "Laboratory report"
    expect(by("fhir:uuid-style-0000-0000-0000-00000000000d").panel).toBe("Comprehensive metabolic panel");
  });
  it("names each feed from evidence in the export, and says which patients it could not name", () => {
    expect(by("fhir:uuid-style-0000-0000-0000-00000000000c").performer).toBe("Example Clinic");
    expect(by("fhir:hosp-obs-0000000000000000000000000000000000000000000000000000001").performer).toBe("Example Hospital");
    expect(by("fhir:shortid0000000000000a").performer).toBeNull();
    expect(parsed.unlabelled_patients).toEqual(["Zq9xK-FAKEFAKE"]);
    const labelled = parseClinicalRecords(records, TZ, { "Zq9xK": "Example Lab" });
    expect(labelled.results.find((r) => r.id === "fhir:shortid0000000000000a")!.performer).toBe("Example Lab");
    expect(labelled.unlabelled_patients).toEqual([]);
  });
  it("skips what is not a lab result and counts why", () => {
    expect(parsed.skipped).toEqual({ "category_vital-signs": 1, entered_in_error: 1, no_value: 1, duplicate_copy: 3 });
  });
  it("never keeps the patient (subject) or meta in the stored raw record", () => {
    for (const r of parsed.results) { expect(r.raw.subject).toBeUndefined(); expect(r.raw.meta).toBeUndefined(); }
  });
  it("the same report exported twice yields each result once (copies are counted, not stored)", () => {
    const ids = parsed.results.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("fhir:lc-report-0001/")).length).toBe(3);
  });
  it("is stable: parsing twice gives the same ids", () => {
    expect(parseClinicalRecords(records, TZ).results.map((r) => r.id)).toEqual(parsed.results.map((r) => r.id));
  });
  it("never throws on junk", () => {
    for (const j of [[], [null, 5, "x", {}, { resourceType: "Observation" }, { resourceType: "DiagnosticReport", id: "x", contained: "no" }]]) {
      expect(() => parseClinicalRecords(j as unknown[], TZ)).not.toThrow();
    }
  });
});
