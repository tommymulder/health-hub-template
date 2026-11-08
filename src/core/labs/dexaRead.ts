import { daysBetween, localDate } from "../time";
import type { ToolCtx } from "../tools/context";
import type { Reading } from "../tools/apple";
import { lbToKg, outWeight, round1, type Units } from "../units";
import { DEXA_PANEL } from "./dexa";

// Reading DEXA scans back. Stored rows are just what each report printed; everything below (changes, left vs right,
// region fat %, the scale comparison) is computed here at read time, so a fix in a formula fixes every past scan.
export interface DexaScan { date: string; clinic: string | null; values: Map<string, { value: number; unit: string | null }> }

export async function loadDexaScans(ctx: ToolCtx): Promise<DexaScan[]> {
  const rows = await ctx.sql<{ collected_at: Date; test_name: string; value_num: number; unit: string | null; performer: string | null }[]>`
    select collected_at, test_name, value_num, unit, performer from lab_results where panel = ${DEXA_PANEL} and value_num is not null order by collected_at`;
  const scans = new Map<string, DexaScan>();
  for (const r of rows) {
    const date = localDate(r.collected_at, ctx.timezone);
    const key = `${date}|${r.performer ?? ""}`;
    const s = scans.get(key) ?? { date, clinic: r.performer, values: new Map() };
    s.values.set(r.test_name, { value: r.value_num, unit: r.unit });
    scans.set(key, s);
  }
  return [...scans.values()];
}

const kgOf = (s: DexaScan, name: string): number | null => {
  const v = s.values.get(`DEXA ${name}`);
  return v ? (v.unit === "kg" ? v.value : v.unit === "lb" ? lbToKg(v.value) : null) : null;
};
const numOf = (s: DexaScan, name: string): number | null => s.values.get(`DEXA ${name}`)?.value ?? null;
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

const DIFFERENT_CLINIC_NOTE = "These scans are from different clinics, so the scanners and software differ: changes smaller than about 1 point of body fat or 2 lb of lean mass (0.9 kg) may be the machine, not the body. Body fat % change is on one base (fat mass ÷ total mass), whatever each clinic printed.";
const SCAN_NOTE = "DEXA is the measure for fat versus muscle, and only between scan dates; the daily scale is a day-to-day estimate. body_fat_pct here is fat mass ÷ total mass (the usual basis; some clinics print fat ÷ (fat + lean) instead), computed from the scan's own masses; body_fat_pct_printed is what the clinic printed, which some clinics base on fat + lean instead, so it can read higher. The left-vs-right and region fat % figures are computed from what the report printed (derived). RMR on these reports is a formula estimate, not a measurement.";

// Body fat % on ONE base (fat mass ÷ total mass, the usual basis), whatever the clinic printed. When the masses
// are missing, fall back to the printed number.
function fatPct(s: DexaScan): number | null {
  const fat = kgOf(s, "fat mass"), total = kgOf(s, "total mass");
  return fat !== null && total !== null && total > 0 ? (fat / total) * 100 : numOf(s, "body fat %");
}

export function dexaBlock(scansIn: DexaScan[], scale: Reading[], units: Units) {
  const scans = [...scansIn].sort((a, b) => a.date.localeCompare(b.date));
  if (scans.length === 0) return { latest: null, note: "No DEXA scans are stored yet. To add one, read the report and call log_lab_results (dry run first) with dexa numbers." };
  const cur = scans[scans.length - 1], prev = scans[scans.length - 2];
  const out = (kg: number | null) => outWeight(kg, units);
  const diffOut = (a: number | null, b: number | null) => (a === null || b === null ? null : out(a - b));

  const latest = compact({
    date: cur.date, clinic: cur.clinic, scans_on_file: scans.length,
    weight: out(kgOf(cur, "total mass")), body_fat_pct: fatPct(cur) === null ? null : round1(fatPct(cur)!), body_fat_pct_printed: numOf(cur, "body fat %"), lean_mass: out(kgOf(cur, "lean mass")), fat_mass: out(kgOf(cur, "fat mass")),
    bone_mass: out(kgOf(cur, "bone mass")), visceral_fat_mass: out(kgOf(cur, "visceral fat mass")), android_gynoid_ratio: numOf(cur, "android/gynoid ratio"),
  });

  const change = prev ? compact({
    previous_date: prev.date, previous_clinic: prev.clinic, days: daysBetween(prev.date, cur.date),
    weight: diffOut(kgOf(cur, "total mass"), kgOf(prev, "total mass")),
    body_fat_pct: fatPct(cur) !== null && fatPct(prev) !== null ? round1(fatPct(cur)! - fatPct(prev)!) : null,
    lean_mass: diffOut(kgOf(cur, "lean mass"), kgOf(prev, "lean mass")), fat_mass: diffOut(kgOf(cur, "fat mass"), kgOf(prev, "fat mass")),
    visceral_fat_mass: diffOut(kgOf(cur, "visceral fat mass"), kgOf(prev, "visceral fat mass")),
    note: (cur.clinic ?? "").trim().toLowerCase() !== (prev.clinic ?? "").trim().toLowerCase() ? DIFFERENT_CLINIC_NOTE : null,
  }) : undefined;

  // The scale weigh-in closest to the scan date (within 3 days; a tie picks the earlier day).
  const near = scale
    .map((r) => ({ r, d: Math.abs(daysBetween(r.day, cur.date)) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d || a.r.day.localeCompare(b.r.day))[0];
  let scaleVs: Record<string, unknown> | null = null;
  if (near) {
    const r = near.r;
    const dexaWeight = kgOf(cur, "total mass"), dexaLean = kgOf(cur, "lean mass"), dexaBone = kgOf(cur, "bone mass"), dexaPct = fatPct(cur) === null ? null : round1(fatPct(cur)!);
    scaleVs = compact({
      scale_date: r.day, days_apart: near.d,
      weight: dexaWeight === null ? null : { scale: out(r.kg), dexa: out(dexaWeight), difference: out(r.kg - dexaWeight) },
      body_fat_pct: r.fat !== null && dexaPct !== null ? { scale: round1(r.fat), dexa: dexaPct, difference: round1(r.fat - dexaPct) } : null,
      // The scale's "lean mass" is fat-free mass, which includes bone, so it is compared with DEXA lean + bone.
      fat_free_mass: r.lean !== null && dexaLean !== null && dexaBone !== null
        ? { scale_lean_mass: out(r.lean), dexa_lean_plus_bone: out(dexaLean + dexaBone), difference: out(r.lean - (dexaLean + dexaBone)) } : null,
      note: "Scale readings are not adjusted: only the differences are shown. The scale's lean mass includes bone, so it is compared with DEXA lean + bone. A home-scale body-fat figure is an estimate.",
    });
  }

  const leftRight: Record<string, unknown> = {};
  for (const [region, single] of [["arms", "arm"], ["legs", "leg"], ["trunk", "trunk"]] as const) {
    const l = kgOf(cur, `lean mass (left ${single})`), r = kgOf(cur, `lean mass (right ${single})`);
    if (l === null || r === null) continue;
    const pct = ((Math.abs(r - l) / ((r + l) / 2)) * 100);
    leftRight[region] = { left_lean: out(l), right_lean: out(r), difference_pct: round1(pct), higher: round1(pct) === 0 ? "equal" : r > l ? "right" : "left", derived: true };
  }

  const regionFat: { region: string; fat_pct: number; derived?: true }[] = [];
  for (const region of ["arms", "legs", "trunk", "android", "gynoid"]) {
    const printed = numOf(cur, `region fat % (${region})`);
    if (printed !== null) { regionFat.push({ region, fat_pct: printed }); continue; }
    const fat = kgOf(cur, `fat mass (${region})`), total = kgOf(cur, `total mass (${region})`);
    if (fat !== null && total !== null && total > 0) regionFat.push({ region, fat_pct: round1((fat / total) * 100), derived: true });
  }

  return {
    units,
    latest,
    ...(change ? { change_since_previous: change } : {}),
    scale_vs_dexa: scaleVs,
    ...(scaleVs === null ? { scale_vs_dexa_note: `No scale weigh-in within 3 days of the scan (${cur.date}).` } : {}),
    ...(Object.keys(leftRight).length ? { left_vs_right: leftRight } : {}),
    ...(regionFat.length ? { region_fat_pct: regionFat } : {}),
    note: SCAN_NOTE,
  };
}

