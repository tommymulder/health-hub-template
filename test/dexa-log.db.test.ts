import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { logLabResults } from "@/core/labs/log";
import { getLabResults } from "@/core/labs/read";
import type { ToolCtx } from "@/core/tools/context";

// Synthetic numbers only; every test is rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function inRollback(fn: (tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (tx) => { await fn(tx as unknown as Sql); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const ctxOf = (tx: Sql): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", now: () => new Date("2031-12-31T20:00:00Z") });

const scan = (date: string, performer: string, over: Record<string, number> = {}) => ({
  collected_at: date, performer,
  results: [
    { dexa: { metric: "total_mass" }, value: over.total ?? 200, unit: "lb" },
    { dexa: { metric: "lean_mass" }, value: over.lean ?? 150, unit: "lb" },
    { dexa: { metric: "fat_mass" }, value: over.fat ?? 44, unit: "lb" },
    { dexa: { metric: "bone_mass" }, value: 6, unit: "lb" },
    { dexa: { metric: "body_fat_pct" }, value: over.pct ?? 22, unit: "%" },
    { dexa: { metric: "lean_mass", region: "arms", side: "left" }, value: 12, unit: "lb" },
    { dexa: { metric: "bmd_z_score" }, value: 0.3 },
  ],
});

describe.skipIf(!sql)("DEXA logging through log_lab_results (always rolled back)", () => {
  it("builds the canonical name, forces panel DEXA, keeps no reference range or flag; the dry run saves nothing", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      const dry: any = await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A"), { dry_run: true });
      expect(dry).toMatchObject({ dry_run: true, saved: false, summary: { new: 7, already_stored: 0 } });
      expect(dry.results.map((r: any) => r.test)).toContain("DEXA lean mass (left arm)");
      expect(dry.results.map((r: any) => r.test)).toContain("DEXA BMD Z-score");
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("0");

      await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A"));
      const rows = await tx`select test_name, panel, unit, value_num, flag, ref_text, performer, source from lab_results order by test_name`;
      expect(rows).toHaveLength(7);
      const lean = rows.find((r) => r.test_name === "DEXA lean mass")!;
      expect(lean).toMatchObject({ panel: "DEXA", unit: "lb", value_num: 150, flag: null, ref_text: null, performer: "Clinic A", source: "claude_upload" });
      expect(rows.find((r) => r.test_name === "DEXA BMD Z-score")!.unit).toBeNull();
    });
  });

  it("logging the same scan again changes nothing; a corrected number REPLACES the row (no second copy)", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A"));
      const same: any = await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A"));
      expect(same.summary).toMatchObject({ new: 0, already_stored: 7 });
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("7");

      const fixed = scan("2031-01-05", "Clinic A", { lean: 149 });
      const dry: any = await logLabResults(ctxOf(tx), fixed, { dry_run: true });
      expect(dry.summary).toMatchObject({ new: 0, replaced: 1, already_stored: 6 });
      expect(dry.results.find((r: any) => r.test === "DEXA lean mass").status).toBe("will_replace");
      expect(dry.summary.conflicts).toBeUndefined(); // a DEXA correction is not a "both would be kept" conflict
      await logLabResults(ctxOf(tx), fixed);
      const lean = await tx`select value_num from lab_results where test_name = 'DEXA lean mass'`;
      expect(lean).toEqual([{ value_num: 149 }]);
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("7");
    });
  });

  it("a different clinic or date is a separate scan, and get_lab_results (panel DEXA) shows the history", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A", { fat: 44 }));
      await logLabResults(ctxOf(tx), scan("2031-09-10", "Clinic B", { fat: 50 }));
      const r: any = await getLabResults(ctxOf(tx), { panel: "DEXA", test: "DEXA fat mass" });
      expect(r.series).toHaveLength(1);
      expect(r.series[0].history.map((h: any) => [h.date, h.value, h.performer])).toEqual([["2031-01-05", 44, "Clinic A"], ["2031-09-10", 50, "Clinic B"]]);
      expect(r.series[0].trend).toMatchObject({ direction: "up", change: 6 });
    });
  });

  it("a test name that matches regions too puts the exact name first, so the cap never hides it", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      const regions = ["arms", "legs", "trunk"].flatMap((region) => (["both", "left", "right"] as const).map((side) => ({ dexa: { metric: "fat_mass", region, side }, value: 5, unit: "lb" })));
      await logLabResults(ctxOf(tx), { collected_at: "2031-01-05", performer: "Clinic A", results: [...regions, { dexa: { metric: "android_gynoid_ratio" }, value: 1 }, { dexa: { metric: "visceral_fat_mass" }, value: 1, unit: "lb" }, { dexa: { metric: "subcutaneous_fat_mass" }, value: 3, unit: "lb" }, { dexa: { metric: "fat_mass" }, value: 44, unit: "lb" }] });
      const r: any = await getLabResults(ctxOf(tx), { test: "DEXA fat mass" });
      expect(r.matched_tests).toBeGreaterThan(10);
      expect(r.series[0].test).toBe("DEXA fat mass");
    });
  });

  it("refuses bad combinations and units with everything listed, and saves nothing", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      await expect(logLabResults(ctxOf(tx), {
        collected_at: "2031-01-05", performer: "Clinic A",
        results: [
          { dexa: { metric: "lean_mass", region: "android", side: "left" }, value: 5, unit: "lb" },
          { dexa: { metric: "body_fat_pct" }, value: 20, unit: "lb" },
          { dexa: { metric: "lean_mass" }, value: 150 },
          { dexa: { metric: "bmd" }, value: "high" },
        ],
      })).rejects.toThrow(/Nothing was saved[\s\S]*android[\s\S]*%[\s\S]*lb or kg[\s\S]*number/);
      expect((await tx`select count(*) as n from lab_results`)[0].n).toBe("0");
    });
  });

  it("warns about a misread (never blocks), and a duplicate metric in one report is refused", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      const bad: any = await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A", { fat: 60 }), { dry_run: true }); // 150 + 60 + 6 != 200; 60/200 = 30% != 22%
      expect(bad.summary.warnings).toHaveLength(2);
      expect(bad.summary.warnings.join(" ")).toMatch(/lean \+ fat \+ bone/);
      expect(bad.summary.warnings.join(" ")).toMatch(/body fat %/);
      const saved: any = await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A", { fat: 60 }));
      expect(saved).toMatchObject({ saved: true });
      await expect(logLabResults(ctxOf(tx), { collected_at: "2031-01-05", results: [
        { dexa: { metric: "lean_mass" }, value: 150, unit: "lb" }, { dexa: { metric: "lean_mass" }, value: 151, unit: "lb" },
      ] })).rejects.toThrow(/twice/);
    });
  });

  it("an ordinary blood result still needs test_name and still follows the old rules", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      await expect(logLabResults(ctxOf(tx), { collected_at: "2031-01-05", results: [{ test_name: "", value: 1 }] })).rejects.toThrow(/test_name is missing/);
      const saved: any = await logLabResults(ctxOf(tx), { collected_at: "2031-01-05", performer: "Lab", results: [{ test_name: "Glucose", value: 90, unit: "mg/dL", ref_text: "70-99" }] });
      expect(saved.summary).toMatchObject({ new: 1 });
    });
  });
});

import { getBodyMetrics } from "@/core/tools/apple";

describe.skipIf(!sql)("get_body_metrics dexa block (always rolled back)", () => {
  it("reads two logged scans back with the change and the scale comparison; no scans -> null with a note", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`; await tx`delete from apple_samples`;
      const ctx = { ...ctxOf(tx), now: () => new Date("2031-09-12T20:00:00Z") };
      const noScans: any = await (async () => {
        await tx`insert into apple_samples (metric, start_at, source, value, unit) values ('weight_body_mass', '2031-09-09T16:00:00Z', 'Scale App', 95, 'kg')`;
        return getBodyMetrics(ctx, { days: 10 });
      })();
      expect(noScans.dexa).toMatchObject({ latest: null });

      await logLabResults(ctx, scan("2031-01-05", "Clinic A"));
      await logLabResults(ctx, scan("2031-09-10", "Clinic B", { total: 210, lean: 151, fat: 53, pct: 25.2 }));
      await tx`insert into apple_samples (metric, start_at, source, value, unit) values ('body_fat_percentage', '2031-09-09T16:00:00Z', 'Scale App', 24, '%')`;
      const r: any = await getBodyMetrics(ctx, { days: 10 });
      expect(r.dexa.latest).toMatchObject({ date: "2031-09-10", clinic: "Clinic B", weight: 210, scans_on_file: 2 });
      expect(r.dexa.change_since_previous).toMatchObject({ weight: 10, lean_mass: 1 });
      expect(r.dexa.scale_vs_dexa).toMatchObject({ scale_date: "2031-09-09", days_apart: 1 });
      expect(r.dexa.scale_vs_dexa.body_fat_pct).toMatchObject({ scale: 24, dexa: 25.2 });
    });
  });
});

describe.skipIf(!sql)("DEXA rows and the unfiltered lab list (always rolled back)", () => {
  it("the 'latest per test' list leaves DEXA out (it would crowd the blood tests) and points to it; panel DEXA or a test name finds it", async () => {
    await inRollback(async (tx) => {
      await tx`delete from lab_results`;
      await logLabResults(ctxOf(tx), scan("2031-01-05", "Clinic A"));
      await logLabResults(ctxOf(tx), { collected_at: "2031-01-05", performer: "Lab", results: [{ test_name: "Glucose", value: 90, unit: "mg/dL", ref_text: "70-99", panel: "CMP" }] });
      const all: any = await getLabResults(ctxOf(tx), {});
      expect(all.results.map((r: any) => r.test)).toEqual(["Glucose"]);
      expect(all.note).toMatch(/DEXA[\s\S]*panel/);
      const dexa: any = await getLabResults(ctxOf(tx), { panel: "DEXA" });
      expect(dexa.results.length).toBe(7);
      const one: any = await getLabResults(ctxOf(tx), { test: "lean mass" });
      expect(one.series.map((s: any) => s.test)).toContain("DEXA lean mass");
      // only DEXA stored: the unfiltered list says so instead of "no results"
      await tx`delete from lab_results where panel <> 'DEXA'`;
      const onlyDexa: any = await getLabResults(ctxOf(tx), {});
      expect(onlyDexa.results).toEqual([]);
      expect(onlyDexa.note).toMatch(/DEXA/);
    });
  });
});
