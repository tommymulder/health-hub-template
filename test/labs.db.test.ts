import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { logLabResults } from "@/core/labs/log";
import { getLabResults, mergedLabCount } from "@/core/labs/read";
import { createRangeBook } from "@/core/labs/ranges";
import type { ToolCtx } from "@/core/tools/context";

try { process.loadEnvFile(".env.local"); } catch { /* no local env file */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
// A made-up optimal list (the shipped one is a single example): total cholesterol 160-199, triglycerides 50-80.
const optimalRanges = createRangeBook([
  { loinc: ["2093-3"], names: ["Cholesterol, Total"], unit: "mg/dl", optLow: 160, optHigh: 199, lowBelow: 100, under: "below_optimal" },
  { loinc: [], names: ["Triglycerides"], unit: "mg/dl", optLow: 50, optHigh: 80, under: "below_optimal", aboveUntil: 149 },
]);
const ctxOf = (tx: Sql): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", optimalRanges, labPreferredPerformers: ["lab a"], now: () => new Date("2026-10-11T20:00:00Z") });
const clear = (tx: Sql) => tx`delete from lab_results`;

const lipid = (date: string, chol: number, ldl: number, unit = "mg/dL") => ({
  collected_at: date, performer: "Test Lab",
  results: [
    { test_name: "Cholesterol, Total", value: chol, unit, ref_text: "<200", panel: "Lipid Panel", loinc_code: "2093-3" },
    { test_name: "LDL Cholesterol", value: ldl, unit, ref_text: "<100", panel: "Lipid Panel" },
    { test_name: "Triglycerides", value: 90, unit: "mg/dL", ref_text: "<150", panel: "Lipid Panel" },
  ],
});

describe.skipIf(!sql)("lab logging (always rolled back)", () => {
  it("dry run saves nothing; saving twice changes nothing; derived flags are marked", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const dry: any = await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90), { dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, saved: false });
      expect(dry.summary).toMatchObject({ new: 3, already_stored: 0, flagged: ["Cholesterol, Total H"] });
      expect(dry.results[0].flag).toMatch(/H \(derived/);
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("0");

      const saved: any = await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90));
      expect(saved).toMatchObject({ saved: true, summary: { new: 3 } });
      const again: any = await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90));
      expect(again.summary).toMatchObject({ new: 0, already_stored: 3 });
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("3");
      const [row] = await tx`select value_num, unit, ref_high, flag, source, collected_at from lab_results where test_name = 'Cholesterol, Total'`;
      expect(row).toMatchObject({ value_num: 210, unit: "mg/dL", ref_high: 200, flag: "H", source: "claude_upload" });
      expect(row.collected_at.toISOString()).toBe("2026-03-04T20:00:00.000Z");
    });
  });

  it("text values stay text, and a printed flag beats a derived one", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), { collected_at: "2026-03-04", results: [
        { test_name: "PSA", value: "<0.1", unit: "ng/mL" },
        { test_name: "Glucose", value: 120, unit: "mg/dL", ref_low: 70, ref_high: 99, flag: "Normal" },
      ] });
      const rows = await tx`select test_name, value_num, value_text, flag from lab_results order by test_name`;
      expect(rows.map((r) => [r.test_name, r.value_num, r.value_text, r.flag])).toEqual([["Glucose", 120, null, "normal"], ["PSA", null, "<0.1", null]]);
    });
  });

  it("rejects bad input with everything wrong listed at once, and saves nothing", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      const bad = { collected_at: "someday", results: [{ test_name: "", value: 1 }, { test_name: "X", value: "" }, { test_name: "Y", value: 1, loinc_code: "nope", ref_low: 5, ref_high: 1 }] };
      await expect(logLabResults(ctxOf(tx), bad as any)).rejects.toThrow(/Nothing was saved[\s\S]*isn't a date[\s\S]*test_name is missing[\s\S]*value is missing[\s\S]*LOINC[\s\S]*ref_low is above/);
      await expect(logLabResults(ctxOf(tx), { collected_at: "2027-12-01", results: [{ test_name: "X", value: 1 }] })).rejects.toThrow(/future/);
      await expect(logLabResults(ctxOf(tx), { collected_at: "2026-03-04", results: [{ test_name: "X", value: 1 }, { test_name: "x", value: 1 }] })).rejects.toThrow(/appears twice/);
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("0");
    });
  });

  it("a different value for the same test and moment is reported as a conflict, not silently added", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90));
      const r: any = await logLabResults(ctxOf(tx), lipid("2026-03-04", 190, 90), { dry_run: true });
      expect(r.summary.conflicts[0]).toMatch(/Cholesterol, Total: already stored.*210.*now 190/);
    });
  });
});

describe.skipIf(!sql)("lab reading (always rolled back)", () => {
  it("latest per test lists out-of-range first with the previous value and change", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), lipid("2025-03-04", 190, 95));
      await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90));
      const r: any = await getLabResults(ctxOf(tx), {});
      expect(r).toMatchObject({ mode: "latest_per_test", tests: 3, out_of_range: 2 });
      // 210 is above the optimal list's ceiling (199); the lab's own "<200" is kept beside it.
      // Triglycerides 90 are inside the lab's "<150" but above the list's optimal 50-80.
      expect(r.results[0]).toMatchObject({
        test: "Cholesterol, Total", value: 210, flag: "high", reference: "160-199", reference_source: "optimal_range",
        lab_reference: "<200", previous: { value: 190, date: "2025-03-04" }, change: 20, results_on_file: 2,
      });
      expect(r.results[0].flag_derived).toBeUndefined();
      expect(r.results.find((x: { test: string }) => x.test === "Triglycerides")).toMatchObject({
        value: 90, flag: "above_optimal", reference: "50-80", lab_flag: "normal", lab_reference: "<150",
      });
      expect(r.note).toMatch(/not diagnose/i);
      expect(r.note).toMatch(/optimal_range/);
    });
  });

  it("history: matches by name words or LOINC, trend, and rows without a LOINC join the coded series", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), lipid("2024-03-04", 180, 80));
      await logLabResults(ctxOf(tx), lipid("2025-03-04", 195, 90));
      await logLabResults(ctxOf(tx), { collected_at: "2026-03-04", results: [{ test_name: "Cholesterol, Total", value: 210, unit: "mg/dL" }] }); // no loinc this time
      const byName: any = await getLabResults(ctxOf(tx), { test: "total cholesterol" });
      expect(byName.matched_tests).toBe(1);
      const s = byName.series[0];
      expect(s.loinc).toBe("2093-3");
      expect(s.history.map((h: any) => h.value)).toEqual([180, 195, 210]);
      expect(s.trend).toMatchObject({ direction: "up", change: 30 });
      expect(s.trend.per_year).toBeGreaterThan(10);
      const byCode: any = await getLabResults(ctxOf(tx), { test: "2093-3" });
      expect(byCode.series[0].results_on_file).toBe(3);
      const ldl: any = await getLabResults(ctxOf(tx), { test: "ldl" });
      expect(ldl.series).toHaveLength(1);
      await expect(getLabResults(ctxOf(tx), { test: "testosterone" })).rejects.toThrow(/No stored test matches/);
    });
  });

  it("converts only glucose/cholesterol between mg/dL and mmol/L and says so; triglycerides are left as reported", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), lipid("2025-03-04", 200, 100)); // mg/dL
      await logLabResults(ctxOf(tx), { collected_at: "2026-03-04", results: [
        { test_name: "Cholesterol, Total", value: 5.17, unit: "mmol/L", loinc_code: "2093-3" },
        { test_name: "Triglycerides", value: 1.0, unit: "mmol/L" },
      ] });
      const c: any = await getLabResults(ctxOf(tx), { test: "2093-3" });
      expect(c.series[0].unit).toBe("mg/dL");
      expect(c.series[0].history[1].value).toBeCloseTo(199.9, 0);
      expect(c.series[0].history[1].converted_from).toEqual({ value: 5.17, unit: "mmol/L" });
      expect(c.series[0].unit_note).toMatch(/converted to mg\/dL/);
      const t: any = await getLabResults(ctxOf(tx), { test: "triglycerides" });
      expect(t.series[0].unit_note).toMatch(/different units[\s\S]*not a pair this tool converts/);
      expect(t.series[0].history.every((h: any) => !h.converted_from)).toBe(true);
    });
  });

  it("the same result stored by two routes counts once", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await logLabResults(ctxOf(tx), lipid("2026-03-04", 210, 90));
      await tx`insert into lab_results (id, collected_at, test_name, loinc_code, value_num, unit, source)
               select 'apple-' || id, collected_at, test_name, loinc_code, value_num, unit, 'apple_health_records' from lab_results where test_name = 'Cholesterol, Total'`;
      const r: any = await getLabResults(ctxOf(tx), { test: "2093-3" });
      expect(r.series[0].results_on_file).toBe(1);
    });
  });

  it("the same result listed by two providers a few hours apart counts once", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await tx`insert into lab_results (id, collected_at, test_name, loinc_code, value_num, unit, performer, source) values
        ('a', '2021-12-13T18:30:00Z', 'Cholesterol, Total', '2093-3', 155, 'mg/dL', 'Lab A', 'apple_health_records'),
        ('b', '2021-12-13T08:00:00Z', 'Cholesterol, total', '2093-3', 155, 'mg/dL', 'Example Clinic', 'apple_health_records'),
        ('c', '2021-12-14T18:30:00Z', 'Cholesterol, Total', '2093-3', 155, 'mg/dL', 'Lab A', 'apple_health_records')`;
      const r: any = await getLabResults(ctxOf(tx), { test: "2093-3" });
      expect(r.series[0].results_on_file).toBe(2); // a and b are one result; c is another day
      expect(r.series[0].history[0]).toMatchObject({
        date: "2021-12-13", performer: "Lab A", reported_by: ["Example Clinic", "Lab A"],
      });
      expect(r.series[0].history[1].reported_by).toBeUndefined();
    });
  });

  it("'mg/dL' and 'mg/dL (calc)' are one unit: no conversion is claimed", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await tx`insert into lab_results (id, collected_at, test_name, loinc_code, value_num, unit, source) values
        ('a', '2022-10-07T18:30:00Z', 'LDL Chol Calc (NIH)', '13457-7', 123, 'mg/dL', 'x'),
        ('b', '2026-02-18T18:30:00Z', 'LDL-CHOLESTEROL', '13457-7', 113, 'mg/dL (calc)', 'x'),
        ('c', '2026-10-02T18:30:00Z', 'LDL-CHOLESTEROL', '13457-7', 104, 'mg/dL (calc)', 'x')`;
      const r: any = await getLabResults(ctxOf(tx), { test: "ldl" });
      const s = r.series[0];
      expect(s.results_on_file).toBe(3);
      expect(s.unit).toBe("mg/dL (calc)");
      expect(s.unit_note).toBeUndefined();
      expect(s.history.every((h: any) => !h.converted_from)).toBe(true);
    });
  });

  it("panel and since filters narrow the answer; an empty table says so", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      await expect(getLabResults(ctxOf(tx), {})).rejects.toThrow(/No lab results are stored yet/);
      await logLabResults(ctxOf(tx), lipid("2025-03-04", 190, 95));
      await logLabResults(ctxOf(tx), { collected_at: "2026-03-04", results: [{ test_name: "TSH", value: 2.1, unit: "mIU/L", panel: "Thyroid" }] });
      const p: any = await getLabResults(ctxOf(tx), { panel: "lipid" });
      expect(p.tests).toBe(3);
      const s: any = await getLabResults(ctxOf(tx), { since: "2026-01-01" });
      expect(s.results.map((x: any) => x.test)).toEqual(["TSH"]);
      await expect(getLabResults(ctxOf(tx), { panel: "nope" })).rejects.toThrow(/No stored lab results match/);
    });
  });
});

describe.skipIf(!sql)("the same result listed by two labs (always rolled back)", () => {
  it("merges the pair to one result, reported by both, and counts stored vs distinct", async () => {
    await inRollback(async (tx) => {
      await clear(tx);
      // Two systems export the same result under different ids (as an ordering clinic and the lab that ran it do).
      const put = (id: string, performer: string, ref: string | null) => tx`
        insert into lab_results (id, collected_at, test_name, loinc_code, value_num, unit, ref_text, performer, source)
        values (${id}, '2022-08-16T19:00:00Z', 'Vitamin B12', '2132-9', 500, 'pg/mL', ${ref}, ${performer}, 'apple_health_records')`;
      await put("syn-b", "Clinic B", null);
      await put("syn-a", "Lab A", "200-900");
      expect(await mergedLabCount(ctxOf(tx))).toEqual({ stored: 2, distinct: 1 });
      const r: any = await getLabResults({ ...ctxOf(tx), labPreferredPerformers: ["lab a"] }, { test: "2132-9" });
      const day = r.series[0].history.filter((h: { date: string }) => h.date === "2022-08-16");
      expect(day).toHaveLength(1);
      expect(day[0]).toMatchObject({ performer: "Lab A", reported_by: ["Clinic B", "Lab A"] });
    });
  });
});
