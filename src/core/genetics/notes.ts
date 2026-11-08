// Hub-written notes for genetic variants (DESIGN §4.6). This file ships with ONE example, MTHFR C677T; add the variants
// from YOUR report the same way, or leave the list alone: a variant with no note is still stored and listed, just with
// no commentary. The rules every note follows:
//   - a note only appears for a variant the person CARRIES (at least minCopies copies); zero copies gets nothing;
//   - short and conservative: tendencies, not diagnoses, and a pointer to the blood marker that shows what is happening;
//   - never repeat a vendor report's "% functioning" scale, personality descriptions or supplement rules;
//   - never invent an rsID or a prevalence: write only what a source you checked says.

export const GENETICS_NOTE =
  "Genes show tendencies, not diagnoses; the blood markers show what's actually happening.";

export type WatchId = "homocysteine" | "folate_serum" | "folate_rbc" | "b12" | "mma";

export interface VariantNote {
  text: string;
  watch: WatchId[];
}

export interface NoteSpec {
  gene: string; // matched ignoring case
  /** Lower-case fragments of the variant name as reports spell it; any one matching counts. */
  variant: string[];
  /** The note appears only with at least this many copies (a recessive effect needs 2). */
  minCopies: number;
  /** The label shown in the watch-list, e.g. "MTHFR C677T". */
  label: string;
  text: string;
  /** Blood markers (by WATCH_MARKERS in watchlist.ts) that this variant points at. */
  watch: WatchId[];
}

// EXAMPLE: replace or extend with your own variants.
export const VARIANT_NOTES: readonly NoteSpec[] = [
  {
    gene: "MTHFR", variant: ["c677t"], minCopies: 1, label: "MTHFR C677T",
    text: "One copy of MTHFR C677T: the folate-processing enzyme runs at reduced activity (two copies: lower still). Very common. Its main measurable effect is somewhat higher homocysteine, mostly when folate is low.",
    watch: ["homocysteine", "folate_serum", "folate_rbc", "b12"],
  },
];

function specFor(gene: string, variant: string, notes: readonly NoteSpec[]): NoteSpec | null {
  const g = gene.trim().toLowerCase(), v = variant.toLowerCase();
  return notes.find((n) => n.gene.toLowerCase() === g && n.variant.some((frag) => v.includes(frag))) ?? null;
}

// A note only when this person carries the variant the sentence is about. Zero copies gets nothing; a spec that needs
// two copies gets nothing for one.
export function noteFor(gene: string, variant: string, copies: number, notes: readonly NoteSpec[] = VARIANT_NOTES): VariantNote | null {
  if (!Number.isInteger(copies) || copies < 1) return null;
  const spec = specFor(gene, variant, notes);
  if (!spec || copies < spec.minCopies) return null;
  return { text: spec.text, watch: spec.watch };
}

// "MTHFR C677T" rather than the report's longer protein name; unknown variants fall back to the report's own words.
export function variantLabel(gene: string, variant: string, notes: readonly NoteSpec[] = VARIANT_NOTES): string {
  return specFor(gene, variant, notes)?.label ?? `${gene} ${variant}`;
}
