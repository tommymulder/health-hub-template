import { normName } from "./norm";

// Unit handling (DESIGN 4.4): original units are stored and NEVER converted on write. On read we convert
// ONLY the well-known pairs below, and say so. Anything else stays in its own unit with a warning.
const GLUCOSE_MGDL_PER_MMOLL = 18.016; // glucose molar mass 180.16 g/mol
const CHOL_MGDL_PER_MMOLL = 38.67; // cholesterol (total, HDL, LDL, non-HDL)

export type Convertible = "glucose" | "cholesterol";

const GLUCOSE_LOINC = new Set(["2345-7", "2339-0", "1558-6", "1547-9"]);
const CHOL_LOINC = new Set(["2093-3", "2085-9", "13457-7", "18262-6", "2089-1", "43396-1", "9830-1"]);

// Triglycerides, A1c, ratios and urine glucose are different quantities: not convertible with these factors.
export function convertibleKind(testName: string, loinc: string | null): Convertible | null {
  if (loinc) {
    if (GLUCOSE_LOINC.has(loinc)) return "glucose";
    if (CHOL_LOINC.has(loinc)) return "cholesterol";
  }
  const n = normName(testName);
  if (/\b(ratio|urine|a1c|hemoglobin|tolerance|mean|estimated|triglycerid\w*)\b/.test(n)) return null;
  if (/\bglucose\b/.test(n)) return "glucose";
  if (/\bcholesterol\b/.test(n)) return "cholesterol";
  return null;
}

// "mg/dL", "mg/dL (calc)" and " MG/DL " are the same unit written three ways.
export const canonUnit = (u: string | null | undefined): string => (u ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, "");

const unitKey = (u: string | null | undefined): "mg/dl" | "mmol/l" | null => {
  const t = canonUnit(u);
  if (t === "mg/dl") return "mg/dl";
  if (t === "mmol/l") return "mmol/l";
  return null;
};

// Convert `value` from unit `from` to unit `to`, or null when this pair isn't a known conversion.
export function convertValue(kind: Convertible, value: number, from: string | null, to: string): number | null {
  const f = unitKey(from), t = unitKey(to);
  if (!f || !t) return null;
  if (f === t) return value;
  const factor = kind === "glucose" ? GLUCOSE_MGDL_PER_MMOLL : CHOL_MGDL_PER_MMOLL;
  return f === "mg/dl" ? value / factor : value * factor;
}
