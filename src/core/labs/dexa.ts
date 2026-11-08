import { createHash } from "node:crypto";
import { kgToLb } from "../units";
import { normName } from "./norm";

// A DEXA scan is a set of dated measurements from a provider, so it is stored as lab results (panel DEXA). Two clinics
// label the same number differently ("Lean Tissue" vs "Lean Mass"), so every number gets ONE canonical name here,
// whichever clinic printed it. Pure helpers: no database, no Next imports (DESIGN D9).
export const DEXA_PANEL = "DEXA";

export interface DexaRef { metric: string; region?: string; side?: string }

type UnitKind = "mass" | "%" | "in²" | "g/cm²" | "kg/m²" | "kcal/day" | null;

const WHOLE: Record<string, { label: string; unit: UnitKind }> = {
  total_mass: { label: "total mass", unit: "mass" }, lean_mass: { label: "lean mass", unit: "mass" }, fat_mass: { label: "fat mass", unit: "mass" },
  bone_mass: { label: "bone mass", unit: "mass" }, body_fat_pct: { label: "body fat %", unit: "%" },
  visceral_fat_mass: { label: "visceral fat mass", unit: "mass" }, visceral_fat_area: { label: "visceral fat area", unit: "in²" },
  subcutaneous_fat_mass: { label: "subcutaneous fat mass", unit: "mass" }, android_gynoid_ratio: { label: "android/gynoid ratio", unit: null },
  bmd: { label: "BMD", unit: "g/cm²" }, bmd_t_score: { label: "BMD T-score", unit: null }, bmd_z_score: { label: "BMD Z-score", unit: null },
  bmd_percentile: { label: "BMD percentile", unit: null }, rsmi: { label: "RSMI", unit: "kg/m²" }, rmr_estimate: { label: "RMR estimate", unit: "kcal/day" },
};
const REGION_METRICS: Record<string, { label: string; unit: UnitKind }> = {
  total_mass: WHOLE.total_mass, lean_mass: WHOLE.lean_mass, fat_mass: WHOLE.fat_mass, region_fat_pct: { label: "region fat %", unit: "%" },
};
// Regions with sides (both/left/right) and regions without (the clinic only measures them as one).
const SIDED: Record<string, string> = { arms: "arm", legs: "leg", trunk: "trunk" };
const UNSIDED = ["android", "gynoid"];

const UNIT_SPELLINGS: Record<string, string[]> = {
  "%": ["%", "percent", "pct"], "in²": ["in²", "in2", "in^2", "sq in", "sq. in."], "g/cm²": ["g/cm²", "g/cm2", "g/cm^2"],
  "kg/m²": ["kg/m²", "kg/m2", "kg/m^2"], "kcal/day": ["kcal/day", "cal/day", "calories/day", "kcal/d", "kcal"],
};
const norm = (u: string) => u.trim().toLowerCase();

function unitFor(kind: UnitKind, given: string | undefined): { ok: true; unit: string | null } | { ok: false; error: string } {
  if (kind === "mass") {
    if (given === undefined || given.trim() === "") return { ok: false, error: "a mass needs its unit exactly as the report prints it: lb or kg (never guess)." };
    const g = norm(given);
    if (["lb", "lbs", "pound", "pounds"].includes(g)) return { ok: true, unit: "lb" };
    if (["kg", "kgs", "kilogram", "kilograms"].includes(g)) return { ok: true, unit: "kg" };
    return { ok: false, error: `unit "${given}" is not valid for a mass: use lb or kg.` };
  }
  if (kind === null) return given && given.trim() ? { ok: false, error: `this metric has no unit; leave unit out (got "${given}").` } : { ok: true, unit: null };
  if (given === undefined || given.trim() === "") return { ok: true, unit: kind };
  if (UNIT_SPELLINGS[kind].includes(norm(given))) return { ok: true, unit: kind };
  return { ok: false, error: `unit "${given}" is not valid here: this metric is in ${kind}.` };
}

export interface DexaCombo extends DexaRef { unit: UnitKind }

export function validDexaCombos(): DexaCombo[] {
  const out: DexaCombo[] = Object.entries(WHOLE).map(([metric, m]) => ({ metric, unit: m.unit }));
  for (const [region] of Object.entries(SIDED)) for (const side of ["both", "left", "right"]) for (const [metric, m] of Object.entries(REGION_METRICS)) out.push({ metric, region, side, unit: m.unit });
  for (const region of UNSIDED) for (const [metric, m] of Object.entries(REGION_METRICS)) out.push({ metric, region, side: "both", unit: m.unit });
  return out;
}

const listChoices = () =>
  `Whole body: ${Object.keys(WHOLE).join(", ")}. With a region (arms, legs, trunk: side both/left/right; android, gynoid: no side): ${Object.keys(REGION_METRICS).join(", ")}.`;

export type DexaName = { ok: true; name: string; unit: string | null } | { ok: false; error: string };

export function dexaName(ref: DexaRef, unit: string | undefined): DexaName {
  const metric = ref.metric?.trim();
  const region = ref.region?.trim() || undefined;
  const side = ref.side?.trim() || undefined;
  if (!region) {
    if (side && side !== "both") return { ok: false, error: `side "${side}" needs a region. ${listChoices()}` };
    if (metric === "region_fat_pct") return { ok: false, error: "region_fat_pct needs a region; for the whole body use body_fat_pct." };
    const m = WHOLE[metric];
    if (!m) return { ok: false, error: `unknown DEXA metric "${ref.metric}". ${listChoices()}` };
    const u = unitFor(m.unit, unit);
    return u.ok ? { ok: true, name: `DEXA ${m.label}`, unit: u.unit } : { ok: false, error: `${m.label}: ${u.error}` };
  }
  const m = REGION_METRICS[metric];
  if (!m) return { ok: false, error: `"${ref.metric}" can't be combined with a region. ${listChoices()}` };
  let label: string;
  if (region in SIDED) {
    if (side && !["both", "left", "right"].includes(side)) return { ok: false, error: `side must be both, left or right (got "${side}").` };
    label = !side || side === "both" ? region : `${side} ${SIDED[region]}`;
  } else if (UNSIDED.includes(region)) {
    if (side && side !== "both") return { ok: false, error: `${region} has no left or right side.` };
    label = region;
  } else return { ok: false, error: `unknown region "${region}". ${listChoices()}` };
  const u = unitFor(m.unit, unit);
  return u.ok ? { ok: true, name: `DEXA ${m.label} (${label})`, unit: u.unit } : { ok: false, error: `${m.label} (${label}): ${u.error}` };
}

// The id ignores the value on purpose: logging a scan again with a corrected number replaces the row (a blood result
// keeps the content-hash rule, because there a different value is a different result).
export function dexaId(name: string, scanDate: string, performer: string | null | undefined): string {
  return createHash("sha256").update(`dexa|${normName(name)}|${scanDate}|${normName(performer ?? "")}`).digest("hex").slice(0, 32);
}

export interface NamedValue { name: string; value: number; unit: string | null }

const toLb = (r: NamedValue): number | null => (r.unit === "lb" ? r.value : r.unit === "kg" ? kgToLb(r.value) : null);

// Misread checks for the dry run. They only warn: a clinic's own rounding can disagree a little.
export function dexaWarnings(rows: NamedValue[]): string[] {
  const by = new Map(rows.map((r) => [r.name, r]));
  const lb = (n: string) => { const r = by.get(n); return r ? toLb(r) : null; };
  const out: string[] = [];
  for (const [region, single] of Object.entries(SIDED)) {
    for (const metric of ["total_mass", "lean_mass", "fat_mass"]) {
      const label = WHOLE[metric].label;
      const t = lb(`DEXA ${label} (${region})`), l = lb(`DEXA ${label} (left ${single})`), r = lb(`DEXA ${label} (right ${single})`);
      if (t !== null && l !== null && r !== null && Math.abs(l + r - t) > 0.3)
        out.push(`${label} (${region}): left ${l.toFixed(1)} + right ${r.toFixed(1)} = ${(l + r).toFixed(1)} lb, but the total is ${t.toFixed(1)} lb. Check the numbers against the report.`);
    }
  }
  const total = lb("DEXA total mass"), lean = lb("DEXA lean mass"), fat = lb("DEXA fat mass"), bone = lb("DEXA bone mass");
  if (total !== null && lean !== null && fat !== null && bone !== null && Math.abs(lean + fat + bone - total) > 1.5)
    out.push(`lean + fat + bone = ${(lean + fat + bone).toFixed(1)} lb, but total mass is ${total.toFixed(1)} lb. Check the numbers against the report.`);
  // Clinics print body fat % on different bases: some divide fat by total mass, others by fat + lean (no bone).
  // Either is fine; only a number that matches neither looks like a misread.
  const pct = by.get("DEXA body fat %");
  if (total !== null && fat !== null && total > 0 && pct) {
    const ofTotal = (fat / total) * 100, ofTissue = lean !== null && fat + lean > 0 ? (fat / (fat + lean)) * 100 : null;
    if (Math.abs(pct.value - ofTotal) > 0.5 && (ofTissue === null || Math.abs(pct.value - ofTissue) > 0.5))
      out.push(`body fat % is printed as ${pct.value}, but fat mass ÷ total mass is ${ofTotal.toFixed(1)}%${ofTissue === null ? "" : ` and fat ÷ (fat + lean) is ${ofTissue.toFixed(1)}%`}. Check the numbers against the report.`);
  }
  return out;
}
