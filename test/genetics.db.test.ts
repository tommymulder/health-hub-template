import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { logGeneticVariants } from "@/core/genetics/log";
import { getGenetics } from "@/core/genetics/read";
import { VARIANT_NOTES, type NoteSpec } from "@/core/genetics/notes";
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
// Made-up notes (the shipped list is one example): the read path takes them from the context.
const variantNotes: NoteSpec[] = [
  ...VARIANT_NOTES,
  { gene: "GENEA", variant: ["a1b"], minCopies: 1, label: "GENEA A1B", text: "One copy of GENEA A1B.", watch: ["b12", "mma"] },
  { gene: "GENEB", variant: ["c2d"], minCopies: 2, label: "GENEB C2D", text: "Two copies of GENEB C2D.", watch: [] },
];
const ctxOf = (tx: Sql): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units: "lb", variantNotes, now: () => new Date("2026-10-17T20:00:00Z") });

const report = {
  source: "Test Genetics",
  collected_at: "2023-08-21",
  reported_at: "2023-08-30",
  variants: [
    { gene: "MTHFR", variant: "C677T", rsid: "rs0000001", variant_copies: 1, reported_as: "Heterozygous" },
    { gene: "MTHFR", variant: "A1298C", rsid: "rs0000002", variant_copies: 0, reported_as: "Homozygous Negative" },
    { gene: "GENEA", variant: "A1B", rsid: "rs0000003", variant_copies: 1, reported_as: "Heterozygous" },
    { gene: "GENEB", variant: "C2D", rsid: "rs0000004", variant_copies: 2, reported_as: "Homozygous Positive" },
  ],
};

describe.skipIf(!sql)("genetic logging (always rolled back)", () => {
  it("saving the same report twice adds nothing, and a changed genotype is refused", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxOf(tx);
      const first = await logGeneticVariants(ctx, report);
      expect(first.summary).toMatchObject({ new: 4, already_stored: 0 });
      const again = await logGeneticVariants(ctx, report);
      expect(again.summary).toMatchObject({ new: 0, already_stored: 4 });
      expect((await tx`select count(*)::int as n from genetic_variants where source = 'Test Genetics'`)[0].n).toBe(4);
      await expect(logGeneticVariants(ctx, { ...report, variants: [{ ...report.variants[0], variant_copies: 2, reported_as: "Homozygous Positive" }] }))
        .rejects.toThrow(/already stored as 1 copies/);
      expect((await tx`select variant_copies from genetic_variants where source = 'Test Genetics' and gene = 'MTHFR' and variant = 'C677T'`)[0].variant_copies).toBe(1);
    });
  });

  it("the watch-list flags a draw older than 12 months, and says when a marker was never measured", async () => {
    await inRollback(async (tx) => {
      const ctx = ctxOf(tx);
      await tx`delete from lab_results`;
      await logGeneticVariants(ctx, report);
      await tx`insert into lab_results (id, collected_at, test_name, loinc_code, value_num, unit, performer, source) values
        ('h1', '2022-10-07T19:00:00Z', 'Homocysteine', '13965-9', 8, 'umol/L', 'Lab A', 'test'),
        ('b-lab', '2022-08-16T19:00:00Z', 'Cobalamin', '2132-9', 400, 'pg/mL', 'Lab A', 'test'),
        ('b-om', '2022-08-16T16:00:00Z', 'Vitamin B12', '2132-9', 400, 'pg/mL', 'Clinic B', 'test'),
        ('b-new', '2026-10-02T19:00:00Z', 'Vitamin B12', '2132-9', 500, 'pg/mL', 'Lab C', 'test'),
        ('f1', '2026-02-18T19:00:00Z', 'Folate', '2284-8', 12, 'ng/mL', 'Lab C', 'test'),
        ('f2', '2026-10-02T19:00:00Z', 'Folate', '2284-8', 18, 'ng/mL', 'Lab C', 'test')`;
      const g: any = await getGenetics(ctx, {});
      expect(g.note).toMatch(/not diagnoses/);
      // Judge the notes on the rows this test inserted.
      const ours = g.variants.filter((v: { source?: string }) => v.source === undefined || v.source === "Test Genetics");
      expect(ours.filter((v: { note?: string }) => v.note).map((v: { gene: string }) => v.gene)).toEqual(["GENEB", "GENEA", "MTHFR"].sort());
      expect(ours.find((v: { variant: string }) => v.variant === "A1298C").note).toBeUndefined();
      const byName = Object.fromEntries(g.watch_list.map((w: { marker: string }) => [w.marker, w]));
      expect(byName.Homocysteine.stale).toBe(true);
      expect(byName.Homocysteine.stale_note).toMatch(/2022-10-07/);
      expect(byName["Vitamin B12"].stale).toBe(false);
      expect(byName["Vitamin B12"].latest).toMatchObject({ value: 500, date: "2026-10-02" });
      expect(byName["Vitamin B12"].trend.direction).toBe("up");
      expect(byName["Folate (serum)"].trend).toMatchObject({ direction: "up" });
      expect(byName["Folate (RBC)"].status).toBe("not measured yet");
      expect(byName["Methylmalonic acid"].status).toBe("not measured yet");
      const b12 = await getGenetics(ctx, {});
      const history = b12.watch_list.find((w) => w.loinc === "2132-9");
      expect(history && "latest" in history && history.latest.date).toBe("2026-10-02");
    });
  });
});
