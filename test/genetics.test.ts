import { describe, it, expect } from "vitest";
import { noteFor, variantLabel, VARIANT_NOTES, type NoteSpec } from "@/core/genetics/notes";
import { agoPhrase, isStale, staleNote } from "@/core/genetics/watchlist";
import { planGeneticVariants } from "@/core/genetics/log";

const variant = (over: Record<string, unknown> = {}) => ({
  gene: "MTHFR", variant: "C677T", variant_copies: 1, reported_as: "Heterozygous", rsid: "rs1801133", ...over,
});

// Made-up genes: the rules are tested on these, so no real person's variants appear in the tests.
const NOTES: NoteSpec[] = [
  { gene: "GENEA", variant: ["a1b"], minCopies: 1, label: "GENEA A1B", text: "One copy of GENEA A1B: a small, common effect.", watch: ["b12"] },
  { gene: "GENEB", variant: ["c2d", "g9h"], minCopies: 2, label: "GENEB C2D", text: "Two copies of GENEB C2D: a tendency, never a diagnosis.", watch: [] },
];

describe("genetic notes", () => {
  it("writes a note only when at least one copy is carried, and only for the genotype the sentence describes", () => {
    expect(noteFor("GENEA", "A1B", 0, NOTES)).toBeNull(); // zero copies: nothing
    expect(noteFor("genea", "variant A1B (long name)", 1, NOTES)?.text).toMatch(/small, common/); // gene case and spelling
    expect(noteFor("GENEA", "A1B", 1, NOTES)?.watch).toEqual(["b12"]);
    expect(noteFor("GENEB", "C2D", 1, NOTES)).toBeNull(); // needs two copies
    expect(noteFor("GENEB", "g9h", 2, NOTES)?.text).toMatch(/never a diagnosis/);
    expect(noteFor("GENEB", "C2D", 2, NOTES)?.watch).toEqual([]);
    expect(noteFor("GENEC", "X", 2, NOTES)).toBeNull(); // not on the list: stored, but no commentary
    expect(noteFor("GENEA", "A1B", 1.5, NOTES)).toBeNull();
  });

  it("the shipped list holds one example and follows the same rules", () => {
    expect(VARIANT_NOTES).toHaveLength(1);
    expect(noteFor("MTHFR", "C677T", 0)).toBeNull();
    expect(noteFor("MTHFR", "C677T", 1)?.watch).toEqual(["homocysteine", "folate_serum", "folate_rbc", "b12"]);
    expect(noteFor("MTHFR", "A1298C", 1)).toBeNull(); // a different variant of the same gene gets no note
  });

  it("labels a listed variant short and an unlisted one in the report's words", () => {
    expect(variantLabel("GENEB", "g9h long name", NOTES)).toBe("GENEB C2D");
    expect(variantLabel("GENEZ", "Z9", NOTES)).toBe("GENEZ Z9");
  });
});

describe("watch-list staleness", () => {
  const today = "2026-10-17";

  it("the 12-month anniversary is not stale, and the next day is", () => {
    expect(isStale("2025-10-17", today)).toBe(false);
    expect(isStale("2025-10-16", today)).toBe(true);
    expect(isStale("2022-10-07", today)).toBe(true);
  });

  it("phrases the homocysteine gap the way the coach should say it", () => {
    expect(agoPhrase("2022-10-07", today)).toBe("about 4 years ago");
    expect(staleNote("Homocysteine", "2022-10-07", today)).toBe(
      "Homocysteine was last measured 2022-10-07 (about 4 years ago): worth asking your doctor to add it at your next blood draw.",
    );
  });
});

describe("genetic variant validation", () => {
  const call = (variants: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
    planGeneticVariants({ source: "Example Genetics Co", collected_at: "2023-08-21", variants: variants as never, ...over });

  it("rejects a bad rsID, 3 copies, and the same variant twice", () => {
    expect(() => call([variant({ rsid: "RS1801133" })])).toThrow(/isn't a valid rsID/);
    expect(() => call([variant({ rsid: "rs" })])).toThrow(/Never invent one/);
    expect(() => call([variant({ variant_copies: 3 })])).toThrow(/variant_copies must be 0, 1 or 2/);
    expect(() => call([variant(), variant({ gene: "mthfr" })])).toThrow(/listed twice/);
  });

  it("allows a missing rsID and keeps a valid plan", () => {
    const planned = call([variant({ rsid: undefined, variant_copies: 0 }), { gene: "GENEA", variant: "A1B", variant_copies: 1, reported_as: "Heterozygous" }]);
    expect(planned.map((p) => [p.gene, p.rsid, p.variant_copies])).toEqual([["MTHFR", null, 0], ["GENEA", null, 1]]);
  });

  it("rejects a bad date before anything is planned", () => {
    expect(() => call([variant()], { collected_at: "August 2023" })).toThrow(/Nothing was saved[\s\S]*isn't a date/);
  });
});
