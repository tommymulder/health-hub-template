import type { Sql } from "../db";
import { addDays, daysBetween, localDate } from "../time";
import type { NoteSpec } from "../genetics/notes";
import type { RangeBook } from "../labs/ranges";
import type { ModuleSet } from "../modules";
import type { Units } from "../units";

export interface ToolCtx {
  sql: Sql;
  timezone: string;
  units: Units;
  hrMax?: number; // only for finding a class's window (HR_MAX env, default 190)
  hrZones?: readonly number[]; // heart-rate zone lower bounds (HR_ZONES env)
  optimalRanges?: RangeBook; // the optional "optimal" lab ranges (default: the list in labs/ranges.ts)
  labPreferredPerformers?: readonly string[]; // LAB_PREFERRED_PERFORMERS: which lab's copy wins when two list the same result
  variantNotes?: readonly NoteSpec[]; // genetic-variant notes (default: VARIANT_NOTES in genetics/notes.ts)
  modules?: ModuleSet; // the optional areas that are on (HUB_MODULES); absent = all on (tests, scripts)
  now?: () => Date;
}

export const todayLocal = (ctx: ToolCtx): string => localDate(ctx.now?.() ?? new Date(), ctx.timezone);

// A problem the caller can fix (unknown workout, bad input). Shown to Claude as
// a normal error message, not a crash.
export class ToolError extends Error {}

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const MAX_WINDOW_DAYS = 366;
export function resolveWindow(ctx: ToolCtx, input: { days?: number; start?: string; end?: string }, defaultDays: number) {
  const end = input.end ?? todayLocal(ctx);
  const start = input.start ?? addDays(end, -((input.days ?? defaultDays) - 1));
  if (start > end) throw new ToolError(`start (${start}) is after end (${end}).`);
  if (daysBetween(start, end) + 1 > MAX_WINDOW_DAYS) throw new ToolError(`Window too long; the maximum is ${MAX_WINDOW_DAYS} days.`);
  return { start, end };
}
