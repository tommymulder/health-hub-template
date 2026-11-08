// Store kg, convert at the tool boundary (DESIGN D6).
export type Units = "lb" | "kg";

const KG_PER_LB = 0.45359237; // exact, by definition

// Full precision, no rounding, so 225 lb round-trips to exactly 225 (§8 create_routine).
export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;

export const round1 = (n: number): number => Math.round(n * 10) / 10;

// For display: convert, then round to 0.1 so 61.235 kg shows as 135 lb.
export function outWeight(kg: number | null | undefined, units: Units): number | null {
  if (kg === null || kg === undefined) return null;
  return round1(units === "lb" ? kgToLb(kg) : kg);
}
