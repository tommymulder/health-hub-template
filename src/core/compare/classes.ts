import type { Sql } from "../db";
import type { CBlock, CClass, CDone, CTarget } from "./completion";

// Every logged class as the pure completion code wants it (Phase 19). Completion is never stored: it is computed from
// these stored facts, so a better rule (or a fixed partner split) recalculates every past class.
export interface StoredClass extends CClass { start_at: Date; session_id: number; coaching_note: string | null }

interface Row {
  sid: string; title: string; class_type: string; local_date: string; start_at: Date; planned: { blocks?: { label?: string; finish_s?: number }[] } | null; coaching_note: string | null; completion_excluded: string | null;
  bid: string | null; label: string | null; format: string | null; sets_min: number | null; sets_max: number | null; rounds: number | null; sets_done: string | null;
  movement: string | null; target: CTarget | null; variant_done: string | null; done_sets: CDone[] | null; assumed: boolean | null;
}

export async function loadCompletionClasses(sql: Sql, opts: { excludeId?: number } = {}): Promise<StoredClass[]> {
  const rows = await sql<Row[]>`
    select s.id as sid, s.title, s.class_type, s.local_date::text as local_date, s.start_at, s.planned, s.coaching_note, s.completion_excluded,
           b.id as bid, b.label, b.format, b.sets_min, b.sets_max, b.rounds, b.sets_done,
           m.movement, m.target, m.variant_done, m.done_sets, m.assumed
    from class_sessions s
    left join class_blocks b on b.session_id = s.id
    left join class_movements m on m.block_id = b.id
    where (${opts.excludeId ?? null}::bigint is null or s.id <> ${opts.excludeId ?? null})
    order by s.start_at, b.id, m.position`;
  const classes = new Map<string, StoredClass>();
  const blocks = new Map<string, CBlock>();
  for (const r of rows) {
    let c = classes.get(r.sid);
    if (!c) {
      c = { id: Number(r.sid), session_id: Number(r.sid), title: r.title, class_type: r.class_type, date: r.local_date, start_at: new Date(r.start_at), coaching_note: r.coaching_note, excluded: r.completion_excluded, blocks: [] };
      classes.set(r.sid, c);
    }
    if (r.bid === null) continue;
    let b = blocks.get(r.bid);
    if (!b) {
      const finish = r.planned?.blocks?.find((x) => x.label === r.label)?.finish_s ?? null;
      b = { label: r.label!, format: r.format!, sets_min: r.sets_min, sets_max: r.sets_max, rounds: r.rounds, finish_s: finish, sets_done: r.sets_done === null ? null : Number(r.sets_done), movements: [] };
      blocks.set(r.bid, b);
      c.blocks.push(b);
    }
    if (r.movement === null) continue;
    b.movements.push({ movement: r.movement, target: r.target ?? {}, done_sets: r.done_sets ?? [], variant_done: r.variant_done, assumed: Boolean(r.assumed) });
  }
  return [...classes.values()];
}
