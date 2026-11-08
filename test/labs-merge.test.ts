import { describe, it, expect } from "vitest";
import { mergeSameDraw, type MergeRow } from "@/core/labs/merge";

const at = (iso: string) => new Date(iso);
const row = (over: Partial<MergeRow> & Pick<MergeRow, "id">): MergeRow => ({
  collected_at: at("2022-08-16T19:00:00Z"),
  value_num: 10,
  value_text: null,
  unit: "mg/dL",
  ref_low: null,
  ref_high: null,
  ref_text: null,
  performer: null,
  ...over,
});

describe("mergeSameDraw", () => {
  it("merges the same day, value and unit, keeps the row with a range, and lists both sources", () => {
    const merged = mergeSameDraw([
      row({ id: "lab", performer: "Lab A" }),
      row({ id: "om", performer: "Clinic B", ref_text: "4-10", collected_at: at("2022-08-16T15:00:00Z") }),
    ], "America/Los_Angeles");
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("om");
    expect(merged[0].reported_by).toEqual(["Clinic B", "Lab A"]);
  });

  it("when both have a range, keeps the preferred performer (LAB_PREFERRED_PERFORMERS), matching by substring and ignoring case", () => {
    const merged = mergeSameDraw([
      row({ id: "a", performer: "Clinic B", ref_low: 1, ref_high: 10 }),
      row({ id: "b", performer: "Lab A", ref_low: 2, ref_high: 9 }),
    ], "America/Los_Angeles", ["lab a"]); // LAB_PREFERRED_PERFORMERS
    expect(merged[0].id).toBe("b");
    expect(merged[0].reported_by).toEqual(["Clinic B", "Lab A"]);
  });

  it("with no preference set, performers tie and the lowest id wins", () => {
    const merged = mergeSameDraw([
      row({ id: "b", performer: "Clinic B", ref_low: 1, ref_high: 10 }),
      row({ id: "a", performer: "Lab A", ref_low: 2, ref_high: 9 }),
    ], "America/Los_Angeles");
    expect(merged[0].id).toBe("a");
  });

  it("the preference list is ordered: the first name beats the second", () => {
    const rows = [row({ id: "a", performer: "Lab Z", ref_low: 1, ref_high: 10 }), row({ id: "b", performer: "Lab Y", ref_low: 1, ref_high: 10 })];
    expect(mergeSameDraw(rows, "UTC", ["lab y", "lab z"])[0].id).toBe("b");
    expect(mergeSameDraw(rows, "UTC", ["lab z", "lab y"])[0].id).toBe("a");
  });

  it("breaks a remaining tie by the lowest id", () => {
    const merged = mergeSameDraw([
      row({ id: "b", performer: "Lab A", ref_low: 1, ref_high: 10 }),
      row({ id: "a", performer: "Lab A", ref_low: 1, ref_high: 10 }),
    ], "America/Los_Angeles");
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("a");
  });

  it("does not merge a different value on the same day", () => {
    const merged = mergeSameDraw([
      row({ id: "a", value_num: 10, performer: "Lab A" }),
      row({ id: "b", value_num: 11, performer: "Clinic B" }),
    ], "America/Los_Angeles");
    expect(merged.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores unit case, and treats a missing unit like a blank one", () => {
    const merged = mergeSameDraw([
      row({ id: "a", unit: "mg/dL", performer: "Lab A" }),
      row({ id: "b", unit: "MG/DL", performer: "Clinic B" }),
    ], "America/Los_Angeles");
    expect(merged).toHaveLength(1);
    const text = mergeSameDraw([
      row({ id: "c", value_num: null, value_text: "<1.0", unit: null, performer: "Lab A" }),
      row({ id: "d", value_num: null, value_text: "<1.0", unit: "  ", performer: "Clinic B" }),
    ], "America/Los_Angeles");
    expect(text).toHaveLength(1);
    expect(text[0].reported_by).toEqual(["Clinic B", "Lab A"]);
  });

  it("folds text case so Negative matches negative, and keeps a different unit apart", () => {
    const text = mergeSameDraw([
      row({ id: "a", value_num: null, value_text: "Negative", unit: null, performer: "Lab A" }),
      row({ id: "b", value_num: null, value_text: " negative ", unit: null, performer: "Clinic B" }),
    ], "America/Los_Angeles");
    expect(text).toHaveLength(1);
    const units = mergeSameDraw([
      row({ id: "c", unit: "mg/dL", performer: "Lab A" }),
      row({ id: "d", unit: "mmol/L", performer: "Clinic B" }),
    ], "America/Los_Angeles");
    expect(units).toHaveLength(2);
  });

  it("uses the local date, so a late evening UTC instant can be the next local day", () => {
    const merged = mergeSameDraw([
      row({ id: "a", collected_at: at("2022-08-17T06:30:00Z"), performer: "Lab A" }), // 11:30pm local on the 16th
      row({ id: "b", collected_at: at("2022-08-17T15:00:00Z"), performer: "Clinic B" }), // 8am local on the 17th
    ], "America/Los_Angeles");
    expect(merged).toHaveLength(2);
  });
});
