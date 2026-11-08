import { addDays } from "../time";

// The baseline rule (DESIGN D6): compare HRV and resting heart rate with your own 60-day rolling MEDIAN,
// not a short average or a 7-day snapshot. A median is steady: one terrible night does not drag it.
export const BASELINE_DAYS = 60;
export const BASELINE_MIN_SAMPLES = 14; // a thin history must not pose as a "baseline"

export function median(vals: number[]): number | null {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Median of the values in the `window` days BEFORE `day` (not including it).
export function baselineBefore(byDay: Map<string, number>, day: string, window = BASELINE_DAYS, minSamples = BASELINE_MIN_SAMPLES): number | null {
  const vals: number[] = [];
  for (let i = 1; i <= window; i++) {
    const v = byDay.get(addDays(day, -i));
    if (v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < minSamples) return null;
  return median(vals);
}

export function pctVsBaseline(value: number | null | undefined, baseline: number | null): number | null {
  if (value === null || value === undefined || baseline === null || baseline === 0) return null;
  return Math.round(((value - baseline) / baseline) * 1000) / 10;
}
