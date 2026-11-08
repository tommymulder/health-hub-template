import { parseWindowEdge } from "../hr/groups";
import { addDays, localDate, localDateTime, wallClockToInstant } from "../time";
import { ToolError, type ToolCtx } from "../tools/context";
import { nightsFromDocs, segmentFor } from "./night";

export const EVENT_TYPES = ["bathroom"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type EventSource = "shortcut" | "claude" | "button";

export function parseEventType(v: unknown): EventType {
  if (typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v)) return v as EventType;
  throw new ToolError(`type must be one of: ${EVENT_TYPES.join(", ")}.`);
}

export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

// "2:14 AM" (Intl puts a narrow no-break space before AM/PM; make it a plain space).
export const clock12 = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at).replace(/\s/g, " ");

const DEDUPE_SECONDS = 60;

// Saves one press. The HUB stamps the time (the Shortcut sends no clock, so a wrong phone clock or time zone can't
// matter). A second press of the same type within 60 seconds returns the first one and saves nothing (a double press,
// or a retry). One insert, then one read to say which night it was: it must answer fast while the phone is locked.
export async function logPress(ctx: ToolCtx, input: { type: unknown; source: EventSource }) {
  const type = parseEventType(input.type);
  const at = ctx.now?.() ?? new Date();
  const [row] = await ctx.sql<{ id: string; at: Date; duplicate: boolean }[]>`
    with dup as (
      select id, at from events
      where type = ${type} and not hidden and at > ${at}::timestamptz - make_interval(secs => ${DEDUPE_SECONDS}) and at <= ${at}
      order by at desc limit 1),
    ins as (
      insert into events (type, at, source) select ${type}, ${at}, ${input.source} where not exists (select 1 from dup)
      returning id, at)
    select id::text, at, false as duplicate from ins
    union all
    select id::text, at, true as duplicate from dup`;
  const when = new Date(row.at);
  const label = await whichSegment(ctx, type, when);
  const prefix = row.duplicate ? "Already logged" : "Trip logged";
  return { id: Number(row.id), duplicate: row.duplicate, at: when, message: `${prefix} ${clock12(when, ctx.timezone)} (${ordinal(label.n)} ${label.kind === "night" ? "tonight" : "today"})` };
}

// Which night (or day) this press falls in, and its place among that segment's presses.
async function whichSegment(ctx: ToolCtx, type: EventType, at: Date) {
  const d0 = localDate(at, ctx.timezone);
  const docs = await ctx.sql<{ day: string; start_at: Date | null; end_at: Date | null; data: Record<string, unknown> }[]>`
    select day::text as day, start_at, end_at, data from oura_documents
    where collection = 'sleep' and day between ${addDays(d0, -1)} and ${addDays(d0, 2)}`;
  const seg = segmentFor(at.getTime(), nightsFromDocs(docs), ctx.timezone);
  const [c] = await ctx.sql<{ n: number }[]>`
    select count(*)::int as n from events
    where type = ${type} and not hidden and at >= ${new Date(seg.from)} and at < ${new Date(seg.to)} and at <= ${at}`;
  return { kind: seg.kind, n: Math.max(1, c.n) };
}

// ---- log_event: Claude logs a remembered trip, or hides / restores a mis-press ----

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACK_MS = 48 * 3_600_000;

// "03:10" on a given night (wake-up date D): an evening time (12:00 or later) belongs to the evening BEFORE D.
// With no night, "03:10" is the most recent such time in the past. A full date-time with no offset is in the hub's timezone.
function resolveAt(at: string, night: string | undefined, now: Date, tz: string): Date {
  const t = at.trim();
  const m = HHMM.exec(t);
  if (m) {
    const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
    if (night !== undefined) {
      if (!DATE_ONLY.test(night)) throw new ToolError(`night must be a date (YYYY-MM-DD): the wake-up date of the night.`);
      return wallClockToInstant(`${Number(m[1]) >= 12 ? addDays(night, -1) : night}T${hhmm}:00Z`, tz);
    }
    const today = localDate(now, tz);
    const candidate = wallClockToInstant(`${today}T${hhmm}:00Z`, tz);
    return candidate.getTime() > now.getTime() ? wallClockToInstant(`${addDays(today, -1)}T${hhmm}:00Z`, tz) : candidate;
  }
  if (DATE_ONLY.test(t)) throw new ToolError(`at needs a time as well as a date (for example ${t}T03:10).`);
  try { return new Date(parseWindowEdge(t, "start", tz)); }
  catch { throw new ToolError(`at isn't a time I can read: use 03:10 (with night), or an ISO date-time like 2031-05-02T03:10.`); }
}

export async function logEvent(
  ctx: ToolCtx,
  input: { type: unknown; at?: string; night?: string; note?: string; hide_id?: number; restore_id?: number },
) {
  const type = parseEventType(input.type);
  const modes = [input.at !== undefined, input.hide_id !== undefined, input.restore_id !== undefined].filter(Boolean).length;
  if (modes === 0) throw new ToolError("Give at (when they went), or hide_id / restore_id for a mis-press.");
  if (modes > 1) throw new ToolError("Give only one of at, hide_id or restore_id.");
  if (input.note !== undefined && input.note.length > 200) throw new ToolError("note is at most 200 characters.");

  if (input.hide_id !== undefined || input.restore_id !== undefined) {
    const hide = input.hide_id !== undefined, id = (hide ? input.hide_id : input.restore_id) as number;
    const [row] = await ctx.sql<{ id: string; at: Date }[]>`update events set hidden = ${hide} where id = ${id} and type = ${type} returning id::text, at`;
    if (!row) throw new ToolError(`No ${type} event with id ${id}.`);
    return { saved: true, id, hidden: hide, message: `${hide ? "Hid" : "Restored"} the ${localDateTime(new Date(row.at), ctx.timezone)} trip (id ${id}). Nothing was deleted${hide ? ": restore_id brings it back." : "."}` };
  }

  const now = ctx.now?.() ?? new Date();
  const when = resolveAt(input.at as string, input.night, now, ctx.timezone);
  if (when.getTime() > now.getTime()) throw new ToolError("That time is in the future: events are only logged after they happen.");
  if (now.getTime() - when.getTime() > MAX_BACK_MS) throw new ToolError("That is more than 48 hours back: only the last 48 hours can be logged.");
  const nearby = await ctx.sql<{ id: string; at: Date }[]>`
    select id::text, at from events where type = ${type} and not hidden
      and at between ${new Date(when.getTime() - 10 * 60_000)} and ${new Date(when.getTime() + 10 * 60_000)} order by at`;
  const [row] = await ctx.sql<{ id: string }[]>`
    insert into events (type, at, source, approximate, note) values (${type}, ${when}, 'claude', true, ${input.note ?? null}) returning id::text`;
  const label = await whichSegment(ctx, type, when);
  return {
    saved: true, id: Number(row.id), approximate: true, time: localDateTime(when, ctx.timezone),
    message: `Logged ${clock12(when, ctx.timezone)} (approximate, ${ordinal(label.n)} ${label.kind === "night" ? "tonight" : "today"})`,
    ...(nearby.length ? { already_logged_nearby: nearby.map((n) => ({ id: Number(n.id), time: localDateTime(new Date(n.at), ctx.timezone) })), nearby_note: "A press is already logged within 10 minutes of this time: this may be a duplicate. hide_id removes it from the counts if so." } : {}),
  };
}
