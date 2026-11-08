import { normName } from "./norm";

// Optional "optimal" ranges: a narrower band than the lab's own reference range, from a source YOU choose (a longevity
// clinic's report, a coach's list). They ship EMPTY except for one made-up example, because ranges belong to whoever
// wrote them. Add yours in OPTIMAL_RANGES below (see the example), or leave it alone: with no entry for a test, the
// lab's own range and flag are used, which is the default and the safe choice.
// Applied at read time. Stored rows keep whatever range the performing lab printed.
// A LOINC we don't list never falls through to the name: urine "WBC"/"RBC" share those
// names with the blood counts and must not inherit the blood range.

export type LabBand = "low" | "below_optimal" | "optimal" | "above_optimal" | "high";

export interface OptimalRange {
  loinc: string[];
  names: string[];
  /** A unit group. See fits(). The range numbers are in this scale. */
  unit: string;
  optLow: number;
  optHigh: number;
  /** value < this is "low"; the rest of the way up to optLow uses `under`. */
  lowBelow?: number;
  /** What a value below optLow is, once it is not "low". */
  under: "low" | "below_optimal";
  /** value > optHigh and <= this is "above_optimal"; anything higher is "high". Omit when above optimal is already "high". */
  aboveUntil?: number;
}

const THOUSAND = new Set(["10*3/ul", "x10e3/ul", "10e3/ul", "10^3/ul", "k/ul", "k/cumm", "thousand/ul"]);
const MILLION = new Set(["10*6/ul", "x10e6/ul", "10e6/ul", "10^6/ul", "m/ul", "m/cumm", "million/ul"]);

// Parentheticals ("mg/dL (calc)") and brackets ("[IU]/L", "u[iU]/mL") are spelling, not a different unit.
export function canonLabUnit(u: string | null | undefined): string {
  return (u ?? "")
    .toLowerCase()
    .replace(/[μµ]/g, "u")
    .replace(/mcg/g, "ug")
    .replace(/[\[\]{}]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/_/g, "")
    .replace(/\s+/g, "");
}

function fits(kind: string, unit: string | null): boolean {
  const c = canonLabUnit(unit);
  switch (kind) {
    case "ratio": return c === "" || c === "ratio" || c === "index" || c === "calc";
    case "thousand": return THOUSAND.has(c);
    case "million": return MILLION.has(c);
    case "enzyme": return c === "iu/l" || c === "u/l"; // AST/ALT: IU/L and U/L are the same unit here
    case "tsh": return c === "miu/l" || c === "uiu/ml"; // 1 mIU/L = 1 uIU/mL
    case "electrolyte": return c === "mmol/l" || c === "meq/l"; // Na, K, Cl, CO2: 1 mmol = 1 mEq
    case "egfr": return c === "ml/min" || c.startsWith("ml/min/1.73");
    default: return c === kind;
  }
}

function bandOf(value: number, r: OptimalRange): LabBand {
  if (value < r.optLow) {
    if (r.lowBelow !== undefined && value < r.lowBelow) return "low";
    return r.under;
  }
  if (value <= r.optHigh) return "optimal";
  if (r.aboveUntil !== undefined && value <= r.aboveUntil) return "above_optimal";
  return "high";
}

export function optimalText(r: OptimalRange): string {
  return `${r.optLow}-${r.optHigh}`;
}

// A lookup over a list of ranges. The shipped one is OPTIMAL_BOOK; tests build their own.
export interface RangeBook {
  ranges: readonly OptimalRange[];
  /** The range for this result, or null when the book has no band for it or the unit is a different scale
   *  (cells/uL is a thousand times k/cumm; urine WBC is a different test). */
  range(loinc: string | null, testName: string, unit: string | null): OptimalRange | null;
}

export function createRangeBook(list: readonly OptimalRange[]): RangeBook {
  const byLoinc = new Map<string, OptimalRange>();
  const byName = new Map<string, OptimalRange>();
  const ranges: OptimalRange[] = [];
  for (const r of list) {
    const spec: OptimalRange = { ...r, names: [...new Set(r.names.map(normName))] };
    for (const code of spec.loinc) {
      if (byLoinc.has(code)) throw new Error(`Optimal ranges: LOINC ${code} listed twice`);
      byLoinc.set(code, spec);
    }
    for (const n of spec.names) {
      if (byName.has(n)) throw new Error(`Optimal ranges: name "${n}" listed twice`);
      byName.set(n, spec);
    }
    ranges.push(spec);
  }
  return {
    ranges,
    range(loinc, testName, unit) {
      if (loinc && !byLoinc.has(loinc)) return null;
      const spec = (loinc ? byLoinc.get(loinc) : undefined) ?? byName.get(normName(testName));
      if (!spec || !fits(spec.unit, unit)) return null;
      return spec;
    },
  };
}

// YOUR optimal ranges go here. Fields: loinc (codes), names (spellings the lab uses), unit (one of the unit groups in
// fits(), or the plain lower-case unit), optLow / optHigh (the optimal band), lowBelow (under this is "low"), under
// (what a value between lowBelow and optLow is), aboveUntil (above optHigh up to here is "above_optimal"; higher is "high").
// This ONE entry is a made-up example, not advice.
export const OPTIMAL_RANGES: readonly OptimalRange[] = [
  { loinc: ["2093-3"], names: ["Cholesterol, Total", "Total Cholesterol"], unit: "mg/dl", optLow: 150, optHigh: 180, lowBelow: 100, under: "below_optimal", aboveUntil: 200 },
];
// When the list was written (shown to the model so it can say how old the source is). Update it with the list.
export const OPTIMAL_AS_OF = "example";
export const OPTIMAL_BOOK: RangeBook = createRangeBook(OPTIMAL_RANGES);

export const optimalRange = (loinc: string | null, testName: string, unit: string | null): OptimalRange | null => OPTIMAL_BOOK.range(loinc, testName, unit);
export function optimalBand(value: number, range: OptimalRange): LabBand {
  return bandOf(value, range);
}
