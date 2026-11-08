import { daysBetween, localDate } from "../time";
import { ToolError } from "../tools/context";

// Words on each number keep a 4 meaning the same thing next month (DESIGN §4.5).
export const RATING_LABELS: Record<number, string> = {
  5: "Great",
  4: "Good",
  3: "OK",
  2: "Rough",
  1: "Awful",
};

export function ratingLabel(rating: number): string {
  return RATING_LABELS[rating] ?? String(rating);
}

// A Shortcut menu often hands back the words ("5 Great") rather than a bare
// integer. Accept a JSON integer 1-5, the strings "1".."5", or a menu label
// that starts with that digit. Reject 0, 6, 3.5, and words with no digit.
export function parseRating(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[1-5]$/.test(s)) return Number(s);
    const menu = /^([1-5])\s+\S.*$/.exec(s);
    if (menu) return Number(menu[1]);
  }
  throw new ToolError("Rating must be a whole number from 1 (Awful) to 5 (Great).");
}

export function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ToolError("Note must be text.");
  const note = value.trim();
  if (!note) return null;
  if (note.length > 500) throw new ToolError("Note must be 500 characters or fewer.");
  return note;
}

export function parseShortcutBody(input: unknown): { rating: number; note: string | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError("Body must be a JSON object with a rating from 1 to 5 and an optional note.");
  }
  const body = input as Record<string, unknown>;
  return { rating: parseRating(body.rating), note: parseNote(body.note) };
}

// "Wed Oct 15", built from parts so the default en-US form's comma never appears.
// Noon UTC keeps a date-only string on that calendar day.
export function savedMessage(rating: number, day: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(`${day}T12:00:00Z`));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `Saved ${rating}/5 (${ratingLabel(rating)}) for ${get("weekday")} ${get("month")} ${get("day")}`;
}

// Claude may log a morning they forgot, but only today or the two days before.
// A past date is recalled: memory of a morning, not a rating taken that morning.
export function resolveCheckinDay(date: string | undefined, today: string): { day: string; recalled: boolean } {
  if (!date) return { day: today, recalled: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError("date must be YYYY-MM-DD.");
  const back = daysBetween(date, today);
  if (back < 0) throw new ToolError("A check-in date can't be in the future.");
  if (back > 2) throw new ToolError("A recalled rating can only go back 2 days.");
  return { day: date, recalled: back > 0 };
}

// logged_at minus that night's wake time (the long_sleep end). Null when the
// ring has no wake time, so a rating is never paired with a nap's end.
export function hoursAfterWaking(loggedAt: Date, wakeAt: Date | null): number | null {
  if (!wakeAt) return null;
  const hours = (loggedAt.getTime() - wakeAt.getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return null;
  return Math.round(hours * 10) / 10;
}

// On time = from an hour before Oura's wake time to 2 hours after. Rating in bed
// before Oura marks them up gives a small negative number, and that is still on time.
export function onTime(hours: number | null): boolean {
  return hours !== null && hours >= -1 && hours <= 2;
}

// Average ranks: tied values share the mean of the ranks they span.
// [1, 2, 2, 4] → [1, 2.5, 2.5, 4].
export function averageRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n === 0 || n !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let nume = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    nume += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return nume / Math.sqrt(dx * dy);
}

// Spearman rank correlation. Needs 3 or more pairs; a flat series has no correlation.
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

// Linear interpolation on a sorted list. idx = p * (n - 1).
export function quartile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Under 14 mornings the ranking is noise. 14–29 is a hint, not a finding.
export function sampleConfidence(n: number): "too early" | "early pattern, not proven" | "enough mornings to compare" {
  if (n < 14) return "too early";
  if (n < 30) return "early pattern, not proven";
  return "enough mornings to compare";
}
