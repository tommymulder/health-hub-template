import { median } from "../oura/recovery";
import { onTime, quartile, sampleConfidence, spearman } from "./validate";

type Confidence = ReturnType<typeof sampleConfidence>;

export interface RatedMorning {
  day: string;
  rating: number;
  hours_after_waking: number | null;
  sleep_score: number | null;
  total_hours: number | null;
  deep_min: number | null;
  rem_min: number | null;
  efficiency_pct: number | null;
  latency_min: number | null;
  avg_hrv_ms: number | null;
  lowest_hr: number | null;
  temperature_deviation_c: number | null;
  readiness: number | null;
  previous_steps: number | null;
  previous_classes: number | null;
  previous_lifting: number | null;
}

const METRICS: { key: keyof RatedMorning; label: string }[] = [
  { key: "sleep_score", label: "sleep score" },
  { key: "total_hours", label: "sleep hours" },
  { key: "deep_min", label: "deep sleep minutes" },
  { key: "rem_min", label: "REM minutes" },
  { key: "efficiency_pct", label: "sleep efficiency" },
  { key: "latency_min", label: "sleep latency" },
  { key: "avg_hrv_ms", label: "average HRV" },
  { key: "lowest_hr", label: "lowest heart rate" },
  { key: "temperature_deviation_c", label: "temperature deviation" },
  { key: "readiness", label: "readiness" },
  { key: "previous_steps", label: "previous-day steps" },
  { key: "previous_classes", label: "previous-day classes" },
  { key: "previous_lifting", label: "previous-day lifting sessions" },
];

// A mismatch morning is "unusual" when a ring number sits well away from the
// other rated mornings. Small wobble is not worth naming.
const UNUSUAL: { key: keyof RatedMorning; label: string; abs: number }[] = [
  { key: "avg_hrv_ms", label: "HRV", abs: 5 },
  { key: "lowest_hr", label: "lowest heart rate", abs: 3 },
  { key: "readiness", label: "readiness", abs: 5 },
  { key: "total_hours", label: "sleep hours", abs: 0.5 },
  { key: "previous_steps", label: "previous-day steps", abs: 2000 },
  { key: "temperature_deviation_c", label: "temperature deviation", abs: 0.2 },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]): number | null => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function values(rows: RatedMorning[], key: keyof RatedMorning): number[] {
  return rows.map((r) => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function analyzeFeel(rows: RatedMorning[]) {
  const confidence: Confidence = sampleConfidence(rows.length);
  const good = rows.filter((r) => r.rating >= 4);
  const rough = rows.filter((r) => r.rating <= 2);
  const averages = (group: RatedMorning[]) => {
    const out: Record<string, number | null> = {};
    for (const m of METRICS) out[m.key] = mean(values(group, m.key));
    return out;
  };
  const correlations = METRICS.map((m) => {
    const pairs = rows.filter((r) => typeof r[m.key] === "number");
    const rho = spearman(pairs.map((r) => r.rating), pairs.map((r) => r[m.key] as number));
    return { metric: m.key, label: m.label, n: pairs.length, spearman: rho === null ? null : round3(rho) };
  }).filter((c) => c.spearman !== null).sort((a, b) => Math.abs(b.spearman!) - Math.abs(a.spearman!));

  const scores = values(rows, "sleep_score").sort((a, b) => a - b);
  const p25 = quartile(scores, 0.25);
  const p75 = quartile(scores, 0.75);
  const spread = p25 !== null && p75 !== null && p25 !== p75;
  const mismatches = spread ? rows.flatMap((r) => {
    if (r.sleep_score === null) return [];
    const highLow = r.sleep_score >= p75! && r.rating <= 2;
    const lowHigh = r.sleep_score <= p25! && r.rating >= 4;
    if (!highLow && !lowHigh) return [];
    return [{
      day: r.day,
      rating: r.rating,
      sleep_score: r.sleep_score,
      kind: highLow ? "high_score_low_rating" : "low_score_high_rating",
      unusual: unusualAbout(r, rows),
    }];
  }) : [];

  const messages: string[] = [];
  const distinct = new Set(rows.map((r) => r.rating));
  if (rows.length > 0 && distinct.size === 1) {
    messages.push(`Every rating so far is ${rows[0].rating}. There's not enough variety yet to compare against the ring.`);
  } else if (rows.length > 0) {
    if (good.length === 0) messages.push("No good mornings (4-5) yet, so there's nothing to compare the rough ones with.");
    if (rough.length === 0) messages.push("No rough mornings (1-2) yet, so there's nothing to compare the good ones with.");
  }
  return {
    n: rows.length,
    confidence,
    messages,
    note: confidence === "too early"
      ? "Too few mornings to treat any ranking as a finding."
      : confidence === "early pattern, not proven"
        ? "Early pattern, not proven. Do not change a plan from this alone."
        : "Enough mornings to compare. This still does not show cause.",
    good_mornings: { n: good.length, ratings: "4-5", averages: averages(good) },
    rough_mornings: { n: rough.length, ratings: "1-2", averages: averages(rough) },
    correlations,
    sleep_score_quartiles: p25 === null ? null : { p25: round1(p25), p75: round1(p75!) },
    mismatches,
  };
}

function unusualAbout(row: RatedMorning, rows: RatedMorning[]): string[] {
  const others = rows.filter((r) => r.day !== row.day);
  const out: string[] = [];
  for (const u of UNUSUAL) {
    const value = row[u.key];
    if (typeof value !== "number") continue;
    const rest = values(others, u.key);
    if (rest.length < 3) continue;
    const mid = median(rest);
    if (mid === null || Math.abs(value - mid) < u.abs) continue;
    out.push(`${u.label} ${round1(value)} vs median ${round1(mid)}`);
  }
  return out;
}

export function splitFeel(rows: RatedMorning[], onTimeOnly: boolean) {
  const within = rows.filter((r) => onTime(r.hours_after_waking));
  const all = analyzeFeel(rows);
  const onTimeBlock = analyzeFeel(within);
  const headline = onTimeOnly ? onTimeBlock : all;
  return {
    rated_mornings: rows.length,
    confidence: headline.confidence,
    cause: "These are associations, not causes. The ring measures the night. The rating is how the morning felt. Neither one being high makes the other wrong.",
    summary: onTimeOnly
      ? `Headline uses the ${within.length} ratings logged within 2 hours of waking (${headline.confidence}). All ${rows.length} ratings are included below as well.`
      : `${rows.length} rated mornings (${all.confidence}). Both all ratings and those within 2 hours of waking are shown, because a late rating can be colored by the day so far.`,
    all,
    within_2h: onTimeBlock,
  };
}
