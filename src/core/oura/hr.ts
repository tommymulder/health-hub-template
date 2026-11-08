// Pure heart-rate maths for a workout window. Oura samples are IRREGULAR (seconds apart when
// active, minutes apart at rest; ~10 per 35-minute workout in practice), so a plain mean of the
// samples can mislead. Each sample is treated as holding until the next one, capped at 5 minutes
// (a longer silence is a gap, not data), and everything is clipped to the window.
export interface HrPoint { t: number; bpm: number } // t = epoch ms (UTC)

export const MAX_GAP_MS = 5 * 60 * 1000;
export const ZONE_NAMES = ["below_z1", "z1", "z2", "z3", "z4", "z5"] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];

// Lower bounds of zones 1-5 in bpm: example Oura zones (below the first bound is below_z1). Set HR_ZONES to YOUR zones from the Oura app. A setting, not a
// guess from a max heart rate: a guessed max once shifted every zone by about 4 bpm.
export const DEFAULT_HR_ZONES: readonly number[] = [92, 111, 129, 148, 166];

// "92,111,129,148,166" -> five rising integers, otherwise the default.
export function parseHrZones(raw: string | undefined): number[] {
  const parts = (raw ?? "").split(",").map((x) => x.trim());
  const nums = parts.map(Number);
  const ok = parts.length === 5 && parts.every((x) => /^\d+$/.test(x)) && nums.every((n, i) => i === 0 || n > nums[i - 1]);
  return ok ? nums : [...DEFAULT_HR_ZONES];
}

export function zoneOf(bpm: number, zones: readonly number[]): ZoneName {
  for (let i = 4; i >= 0; i--) if (bpm >= zones[i]) return ZONE_NAMES[i + 1];
  return "below_z1";
}

// {"z1": "92-110", ..., "z5": "166+"} for tool output.
export function zoneLabels(zones: readonly number[]): Record<"z1" | "z2" | "z3" | "z4" | "z5", string> {
  const l = (i: number) => (i === 4 ? `${zones[4]}+` : `${zones[i]}-${zones[i + 1] - 1}`);
  return { z1: l(0), z2: l(1), z3: l(2), z4: l(3), z5: l(4) };
}

export interface HrStats {
  samples: number;
  min: number | null;
  max: number | null;
  avg: number | null; // time-weighted
  covered_minutes: number; // minutes of the window actually backed by samples
  window_minutes: number;
  minutes_by_zone: Record<ZoneName, number>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function heartRateStats(points: HrPoint[], startMs: number, endMs: number, zones: readonly number[]): HrStats {
  const inWin = points.filter((p) => p.t >= startMs && p.t <= endMs).sort((a, b) => a.t - b.t);
  const held_by_zone = Object.fromEntries(ZONE_NAMES.map((z) => [z, 0])) as Record<ZoneName, number>;
  let weighted = 0;
  let covered = 0;
  inWin.forEach((p, i) => {
    const next = i + 1 < inWin.length ? inWin[i + 1].t : endMs;
    const dt = Math.max(0, Math.min(next, endMs) - p.t);
    const held = Math.min(dt, MAX_GAP_MS);
    weighted += p.bpm * held;
    covered += held;
    held_by_zone[zoneOf(p.bpm, zones)] += held;
  });
  const bpms = inWin.map((p) => p.bpm);
  return {
    samples: inWin.length,
    min: bpms.length ? Math.min(...bpms) : null,
    max: bpms.length ? Math.max(...bpms) : null,
    avg: covered > 0 ? round1(weighted / covered) : bpms.length ? round1(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null,
    covered_minutes: round1(covered / 60_000),
    window_minutes: round1((endMs - startMs) / 60_000),
    minutes_by_zone: Object.fromEntries(ZONE_NAMES.map((z) => [z, round1(held_by_zone[z] / 60_000)])) as Record<ZoneName, number>,
  };
}
