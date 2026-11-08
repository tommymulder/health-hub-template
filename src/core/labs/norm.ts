import { createHash } from "node:crypto";
import { wallClockToInstant } from "../time";

// Pure helpers for lab results (no database, no Next imports: DESIGN D9).

// Lab test names vary by lab ("Cholesterol, Total" vs "TOTAL CHOLESTEROL"), so compare a normalised
// form: lower case, punctuation gone, words in order. (Deliberately NOT the exercise matcher, which
// rewrites "db" to "dumbbell".)
export const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const isLoinc = (s: string): boolean => /^\d{1,7}-\d$/.test(s.trim());

// "2026-03-04" is a DATE: store local noon so it keeps that date in the user's zone.
// A full timestamp is taken as the exact instant it names.
export function parseCollected(s: string, timeZone: string): { at: Date; dateOnly: boolean } | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { at: wallClockToInstant(`${t}T12:00:00Z`, timeZone), dateOnly: true };
  const d = new Date(t);
  return Number.isNaN(d.getTime()) || !/\d{4}-\d{2}-\d{2}/.test(t) ? null : { at: d, dateOnly: false };
}

export interface ParsedValue { num: number | null; text: string | null }

// "5.4" -> number; "<0.5", "Negative", ">1000" -> text (a bound is not a measurement).
export function parseValue(v: string | number): ParsedValue {
  if (typeof v === "number") return Number.isFinite(v) ? { num: v, text: null } : { num: null, text: String(v) };
  const t = v.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return { num: Number(t), text: null };
  return { num: null, text: t || null };
}

// Reference range text -> numbers where it is simple: "<200", ">=40", "70-99", "3.5 - 5.1".
export function parseRef(text: string | null | undefined): { low: number | null; high: number | null } {
  if (!text) return { low: null, high: null };
  // Real ranges usually end with a unit ("100-199 mg/dL", "<200 mg/dL"): allow trailing text after the numbers.
  const t = text.trim();
  const tail = String.raw`(?:\s+[^\d\s].*)?`;
  let m = new RegExp(String.raw`^<=?\s*(\d+(?:\.\d+)?)${tail}$`).exec(t);
  if (m) return { low: null, high: Number(m[1]) };
  m = new RegExp(String.raw`^>=?\s*(\d+(?:\.\d+)?)${tail}$`).exec(t);
  if (m) return { low: Number(m[1]), high: null };
  m = new RegExp(String.raw`^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)${tail}$`).exec(t);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };
  return { low: null, high: null };
}

export type Flag = "H" | "L" | "normal" | "abnormal" | "critical_high" | "critical_low";

// Labs and FHIR spell flags many ways ("High", "H", "HH", "A", "N"); map the known ones, keep unknowns as null.
export function normFlag(f: string | null | undefined): Flag | null {
  if (!f) return null;
  const t = f.trim().toLowerCase();
  if (["h", "high", "above high normal", "hi"].includes(t)) return "H";
  if (["l", "low", "below low normal", "lo"].includes(t)) return "L";
  if (["hh", "critical high", "above upper panic limits"].includes(t)) return "critical_high";
  if (["ll", "critical low", "below lower panic limits"].includes(t)) return "critical_low";
  if (["n", "normal", "within normal limits", "wnl"].includes(t)) return "normal";
  if (["a", "abnormal", "aa", "positive", "detected"].includes(t)) return "abnormal";
  return null;
}

// Only when a lab gave no flag: derive it from a numeric value and a numeric range. Marked as derived by the caller.
export function deriveFlag(value: number | null, low: number | null, high: number | null): Flag | null {
  if (value === null || (low === null && high === null)) return null;
  if (low !== null && value < low) return "L";
  if (high !== null && value > high) return "H";
  return "normal";
}

// Same test, same moment, same value, same source = the same row, so saving twice changes nothing.
export function labId(testName: string, collectedAt: Date, value: string | number, source: string): string {
  return createHash("sha256").update(`${normName(testName)}|${collectedAt.toISOString()}|${String(value).trim()}|${source}`).digest("hex").slice(0, 32);
}
