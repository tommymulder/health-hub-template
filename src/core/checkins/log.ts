import type { ToolCtx } from "../tools/context";
import { todayLocal } from "../tools/context";
import { parseNote, parseRating, ratingLabel, resolveCheckinDay, savedMessage } from "./validate";

export interface CheckinWrite {
  rating: number;
  note: string | null;
  day: string;
  loggedAt: Date;
  source: "shortcut" | "claude";
  recalled: boolean;
}

export async function upsertCheckin(ctx: ToolCtx, row: CheckinWrite) {
  // One statement: `prev` reads the row as it was before this upsert (every part of a
  // statement sees the same snapshot), so the reply can say what was replaced.
  const [res] = await ctx.sql<{ prev_rating: number | null; prev_source: string | null }[]>`
    with prev as (select rating, source from morning_checkins where day = ${row.day}),
    up as (
      insert into morning_checkins (day, rating, note, logged_at, source, recalled)
      values (${row.day}, ${row.rating}, ${row.note}, ${row.loggedAt}, ${row.source}, ${row.recalled})
      on conflict (day) do update set
        rating = excluded.rating,
        note = excluded.note,
        logged_at = excluded.logged_at,
        source = excluded.source,
        recalled = excluded.recalled,
        updated_at = now()
      returning day)
    select (select rating from prev) as prev_rating, (select source from prev) as prev_source from up`;
  const prev = res?.prev_rating == null ? null : Number(res.prev_rating);
  const replaced = prev === null ? null : { rating: prev, label: ratingLabel(prev), source: res.prev_source };
  return {
    saved: true as const,
    day: row.day,
    rating: row.rating,
    recalled: row.recalled,
    source: row.source,
    replaced,
    message: savedMessage(row.rating, row.day) + (replaced ? `, replacing ${replaced.rating}/5 (${replaced.label})` : ""),
  };
}

// The phone always logs the date of the server clock in the hub's timezone. A second tap
// the same morning replaces the row (idempotent upsert).
export async function saveShortcutCheckin(ctx: ToolCtx, input: { rating: number; note: string | null }) {
  const loggedAt = ctx.now?.() ?? new Date();
  return upsertCheckin(ctx, {
    rating: input.rating,
    note: input.note,
    day: todayLocal({ ...ctx, now: () => loggedAt }),
    loggedAt,
    source: "shortcut",
    recalled: false,
  });
}

export async function logCheckin(ctx: ToolCtx, input: { rating: unknown; note?: unknown; date?: string }) {
  const loggedAt = ctx.now?.() ?? new Date();
  const today = todayLocal({ ...ctx, now: () => loggedAt });
  const { day, recalled } = resolveCheckinDay(input.date, today);
  return upsertCheckin(ctx, {
    rating: parseRating(input.rating),
    note: parseNote(input.note),
    day,
    loggedAt,
    source: "claude",
    recalled,
  });
}
