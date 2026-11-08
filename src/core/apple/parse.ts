import { createHash } from "node:crypto";
import { wallClockToInstant } from "../time";

// Pure parser for Health Auto Export (HAE) JSON, written against REAL payloads
// (test/fixtures/apple-health). No database, no Next imports (DESIGN D9).
//
// Unknown shapes are never guessed at: they are counted in `skipped` and left in
// raw_ingest, so a fixed parser can re-run over them later.

export interface AppleSample {
  metric: string;
  start_at: Date;
  end_at: Date | null;
  source: string;
  value: number | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  extra: Record<string, unknown> | null;
}

export interface AppleWorkout {
  id: string;
  name: string | null;
  start_at: Date;
  end_at: Date;
  source: string | null;
  data: Record<string, unknown>;
}

export interface ParseResult {
  samples: AppleSample[];
  workouts: AppleWorkout[];
  droppedOura: number;
  skipped: Record<string, number>; // metric (or "workouts") -> points we could not read
}

const KJ_PER_KCAL = 4.184;
const KG_PER_LB = 0.45359237;

// "2026-10-10 09:57:54 -0700" -> the exact instant. The trailing offset is part of
// the data, so DST is never guessed. A date-only value ("2026-10-10") is local midnight.
export function parseHaeDate(s: unknown, timeZone: string): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const only = /^(\d{4}-\d{2}-\d{2})$/.exec(s.trim());
  if (only) return wallClockToInstant(`${only[1]}T00:00:00Z`, timeZone);
  return null;
}

// Store energy as kcal and mass as kg whatever units the app was set to, so one
// internal unit stays true (D6). Everything else is kept as sent, with its unit label.
export function normalizeUnit(value: number | null, unit: string | null): { value: number | null; unit: string | null } {
  if (value === null || !unit) return { value, unit };
  const u = unit.toLowerCase();
  if (u === "kj") return { value: value / KJ_PER_KCAL, unit: "kcal" };
  if (u === "lb" || u === "lbs") return { value: value * KG_PER_LB, unit: "kg" };
  return { value, unit };
}

// Source names arrive as plain strings on samples and as {name, identifier}
// objects (sometimes JSON text) on workouts.
export function sourceName(src: unknown): string {
  if (src == null) return "";
  if (typeof src === "string") {
    const t = src.trim();
    if (t.startsWith("{")) {
      try { return sourceName(JSON.parse(t)); } catch { /* plain text that looks odd */ }
    }
    return t;
  }
  if (typeof src === "object") {
    const o = src as { name?: unknown; identifier?: unknown };
    return String(o.name ?? o.identifier ?? "");
  }
  return String(src);
}

// D12: Oura's own copies in Apple Health duplicate what the Oura API gives us losslessly.
export const isOuraSource = (src: unknown): boolean => {
  if (src && typeof src === "object") {
    const o = src as { name?: unknown; identifier?: unknown };
    return /oura/i.test(`${o.name ?? ""} ${o.identifier ?? ""}`);
  }
  return /oura/i.test(sourceName(src)) || (typeof src === "string" && /ouraring/i.test(src));
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const KNOWN = new Set(["date", "start", "end", "startDate", "endDate", "qty", "Min", "Avg", "Max", "source"]);

function parsePoint(metric: string, units: string | null, p: Record<string, unknown>, tz: string): AppleSample | null {
  const start = parseHaeDate(p.start, tz) ?? parseHaeDate(p.startDate, tz) ?? parseHaeDate(p.date, tz);
  if (!start) return null;
  const endRaw = parseHaeDate(p.end, tz) ?? parseHaeDate(p.endDate, tz);
  const end = endRaw && endRaw.getTime() !== start.getTime() ? endRaw : null;

  // Value shapes seen/documented: qty | Min/Avg/Max | systolic+diastolic.
  const q = num(p.qty), avg = num(p.Avg), sys = num(p.systolic);
  const raw = q ?? avg ?? sys;
  if (raw === null) return null; // a shape we have not seen: leave it in raw_ingest
  const { value, unit } = normalizeUnit(raw, units);
  const min = num(p.Min), max = num(p.Max);
  const mm = (x: number | null) => (x === null ? null : normalizeUnit(x, units).value);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!KNOWN.has(k) && v !== undefined) extra[k] = v;
  return {
    metric, start_at: start, end_at: end, source: sourceName(p.source), value,
    min: mm(min), max: mm(max), unit, extra: Object.keys(extra).length ? extra : null,
  };
}

const EXCLUDE_KEYS = new Set(["route", "heartRateData"]); // large series; Oura holds the heart rate

export function parseWorkout(w: Record<string, unknown>, tz: string): AppleWorkout | null {
  const start = parseHaeDate(w.start, tz), end = parseHaeDate(w.end, tz);
  if (!start || !end) return null;
  const source = sourceName(w.source);
  const id = typeof w.id === "string" && w.id
    ? w.id
    : createHash("sha256").update(`${w.name}|${start.toISOString()}|${end.toISOString()}|${source}`).digest("hex").slice(0, 32);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(w)) if (!EXCLUDE_KEYS.has(k)) data[k] = v;
  const aeb = w.activeEnergyBurned as { qty?: unknown; units?: unknown } | undefined;
  const kcal = aeb ? normalizeUnit(num(aeb.qty), typeof aeb.units === "string" ? aeb.units : null) : null;
  if (kcal?.value != null && kcal.unit === "kcal") data.active_kcal = kcal.value;
  return { id, name: typeof w.name === "string" ? w.name : null, start_at: start, end_at: end, source: source || null, data };
}

export function parseHaePayload(payload: unknown, timeZone: string): ParseResult {
  const out: ParseResult = { samples: [], workouts: [], droppedOura: 0, skipped: {} };
  const data = (payload as { data?: { metrics?: unknown; workouts?: unknown } } | null)?.data;
  const skip = (k: string) => { out.skipped[k] = (out.skipped[k] ?? 0) + 1; };

  // Same natural key twice inside one payload: keep the last (a multi-row upsert cannot touch a row twice).
  const seen = new Map<string, AppleSample>();
  for (const m of Array.isArray(data?.metrics) ? (data!.metrics as Record<string, unknown>[]) : []) {
    const metric = typeof m?.name === "string" ? m.name : null;
    if (!metric || !Array.isArray(m.data)) { skip(metric ?? "?"); continue; }
    const units = typeof m.units === "string" ? m.units : null;
    for (const p of m.data as Record<string, unknown>[]) {
      if (isOuraSource(p?.source)) { out.droppedOura++; continue; }
      const s = p && typeof p === "object" ? parsePoint(metric, units, p, timeZone) : null;
      if (!s) { skip(metric); continue; }
      seen.set(`${s.metric}|${s.start_at.toISOString()}|${s.source}`, s);
    }
  }
  out.samples = [...seen.values()];

  const wk = new Map<string, AppleWorkout>();
  for (const w of Array.isArray(data?.workouts) ? (data!.workouts as Record<string, unknown>[]) : []) {
    if (isOuraSource(w?.source)) { out.droppedOura++; continue; }
    const parsed = w && typeof w === "object" ? parseWorkout(w, timeZone) : null;
    if (!parsed) { skip("workouts"); continue; }
    wk.set(parsed.id, parsed);
  }
  out.workouts = [...wk.values()];
  return out;
}
