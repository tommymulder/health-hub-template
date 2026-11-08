import type { Sql } from "../db";
import { inTx } from "../db";
import { loadCompletionClasses } from "../compare/classes";
import { classCompletion, type CClass } from "../compare/completion";
import { normalize } from "../match";
import { ToolError } from "../tools/context";

// One-time repair of classes logged BEFORE Phase 19 (DESIGN Phase 19 F): they have no posted rounds, no whole-block
// totals and no partner shares, so a cash-out split with a partner reads as 25% done. A fix file may do ONLY this:
//   - set rounds on a block, and total / share / optional on a movement's target;
//   - add a posted movement that was skipped (stored with ZERO done, so it counts as 0% of its posted work);
//   - change a per-side movement's done reps to both sides combined (`done_reps`: each exactly double, or already double);
//   - leave a whole class out of completion, with the reason (`exclude_from_completion`).
// Hub only: nothing goes to Hevy and nothing is deleted. Applying twice changes 0 rows.

export interface MovementFix { movement: string; total?: boolean; share?: number; optional?: boolean; done_reps?: number[] }
export interface AddedTarget {
  reps?: number | { min: number; max: number }; reps_by_set?: number[]; distance_m?: number; duration_s?: number; calories?: number;
  total?: boolean; share?: number; optional?: boolean; per_side?: boolean; note?: string;
}
export interface AddMovementFix { movement: string; target: AddedTarget }
export interface BlockFix { label: string; rounds?: number; movements?: MovementFix[]; add_movements?: AddMovementFix[] }
export interface ClassFix { session_id: number; blocks: BlockFix[]; exclude_from_completion?: string }
export interface BoardFixes { classes: ClassFix[] }

const only = (o: Record<string, unknown>, allowed: string[], where: string) => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolError(`${where}: "${extra.join('", "')}" is not allowed. A fix may set only rounds (block); total, share, optional, done_reps (movement); add_movements (block); exclude_from_completion (class).`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const TARGET_KEYS = ["reps", "reps_by_set", "distance_m", "duration_s", "calories", "total", "share", "optional", "per_side", "note"];
function parseAdded(a: unknown, where: string): AddMovementFix {
  if (!isObj(a) || typeof a.movement !== "string" || !a.movement.trim() || !isObj(a.target)) throw new ToolError(`${where}: needs a movement name and a target (what the board posted).`);
  only(a, ["movement", "target"], where); // an added movement is always stored with nothing done
  only(a.target, TARGET_KEYS, `${where} target`);
  const t = a.target;
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
  if (t.reps !== undefined && !(posInt(t.reps) || (isObj(t.reps) && posInt(t.reps.min) && posInt(t.reps.max)))) throw new ToolError(`${where}: reps must be a whole number or { min, max }.`);
  if (t.reps_by_set !== undefined && !(Array.isArray(t.reps_by_set) && t.reps_by_set.every(posInt))) throw new ToolError(`${where}: reps_by_set must be a list of whole numbers.`);
  for (const k of ["distance_m", "duration_s", "calories"]) if (t[k] !== undefined && !(typeof t[k] === "number" && (t[k] as number) > 0)) throw new ToolError(`${where}: ${k} must be above 0.`);
  if (t.share !== undefined && !(typeof t.share === "number" && t.share > 0 && t.share <= 1)) throw new ToolError(`${where}: share must be above 0 and at most 1.`);
  for (const k of ["total", "optional", "per_side"]) if (t[k] !== undefined && typeof t[k] !== "boolean") throw new ToolError(`${where}: ${k} must be true or false.`);
  if (t.note !== undefined && !(typeof t.note === "string" && t.note.length <= 300)) throw new ToolError(`${where}: note must be text of at most 300 characters.`);
  if (t.reps === undefined && t.reps_by_set === undefined && t.distance_m === undefined && t.duration_s === undefined && t.calories === undefined) throw new ToolError(`${where}: the target needs what the board posted (reps, distance_m, duration_s or calories).`);
  return { movement: a.movement.trim(), target: t as AddedTarget };
}

export function parseBoardFixes(raw: unknown): BoardFixes {
  if (!isObj(raw) || !Array.isArray(raw.classes)) throw new ToolError('The fix file must look like { "classes": [ { "session_id": 1, "blocks": [ ... ] } ] }.');
  only(raw, ["classes"], "fix file");
  const classes = raw.classes.map((c, ci): ClassFix => {
    if (!isObj(c) || !Number.isInteger(c.session_id) || !Array.isArray(c.blocks)) throw new ToolError(`classes[${ci}]: needs an integer session_id and a blocks list.`);
    only(c, ["session_id", "blocks", "exclude_from_completion"], `class ${c.session_id}`);
    if (c.exclude_from_completion !== undefined && !(typeof c.exclude_from_completion === "string" && c.exclude_from_completion.trim() && c.exclude_from_completion.length <= 200)) throw new ToolError(`class ${c.session_id}: exclude_from_completion must be a reason of 1 to 200 characters.`);
    const blocks = (c.blocks as unknown[]).map((b, bi): BlockFix => {
      if (!isObj(b) || typeof b.label !== "string" || !b.label.trim()) throw new ToolError(`class ${c.session_id}, blocks[${bi}]: needs a label.`);
      only(b, ["label", "rounds", "movements", "add_movements"], `class ${c.session_id}, block ${b.label}`);
      if (b.rounds !== undefined && !(Number.isInteger(b.rounds) && (b.rounds as number) >= 1 && (b.rounds as number) <= 50)) throw new ToolError(`class ${c.session_id}, block ${b.label}: rounds must be a whole number from 1 to 50.`);
      const movements = (b.movements === undefined ? [] : Array.isArray(b.movements) ? b.movements : null) as unknown[] | null;
      if (movements === null) throw new ToolError(`class ${c.session_id}, block ${b.label}: movements must be a list.`);
      const adds = b.add_movements === undefined ? [] : Array.isArray(b.add_movements) ? (b.add_movements as unknown[]).map((a, ai) => parseAdded(a, `class ${c.session_id}, block ${b.label}, add_movements[${ai}]`)) : (() => { throw new ToolError(`class ${c.session_id}, block ${b.label}: add_movements must be a list.`); })();
      return {
        label: b.label.trim(), ...(b.rounds !== undefined ? { rounds: b.rounds as number } : {}), ...(adds.length ? { add_movements: adds } : {}),
        movements: movements.map((m, mi): MovementFix => {
          if (!isObj(m) || typeof m.movement !== "string" || !m.movement.trim()) throw new ToolError(`class ${c.session_id}, block ${b.label}, movements[${mi}]: needs a movement name.`);
          only(m, ["movement", "total", "share", "optional", "done_reps"], `class ${c.session_id}, block ${b.label}, ${m.movement}`);
          if (m.done_reps !== undefined && !(Array.isArray(m.done_reps) && m.done_reps.length > 0 && m.done_reps.every((x) => Number.isInteger(x) && x >= 1))) throw new ToolError(`class ${c.session_id}, ${m.movement}: done_reps must be a list of whole numbers, one per set.`);
          if (m.share !== undefined && !(typeof m.share === "number" && m.share > 0 && m.share <= 1)) throw new ToolError(`class ${c.session_id}, ${m.movement}: share must be above 0 and at most 1.`);
          for (const k of ["total", "optional"] as const) if (m[k] !== undefined && typeof m[k] !== "boolean") throw new ToolError(`class ${c.session_id}, ${m.movement}: ${k} must be true or false.`);
          return { movement: m.movement.trim(), ...(m.total !== undefined ? { total: m.total as boolean } : {}), ...(m.share !== undefined ? { share: m.share as number } : {}), ...(m.optional !== undefined ? { optional: m.optional as boolean } : {}), ...(m.done_reps !== undefined ? { done_reps: m.done_reps as number[] } : {}) };
        }),
      };
    });
    return { session_id: c.session_id as number, blocks, ...(c.exclude_from_completion !== undefined ? { exclude_from_completion: (c.exclude_from_completion as string).trim() } : {}) };
  });
  return { classes };
}

// `total: false` / `optional: false` mean "not set": the key is removed, so the stored target stays minimal and applying again is a no-op.
function patchTarget(target: Record<string, unknown>, fix: MovementFix): Record<string, unknown> {
  const t = { ...target };
  if (fix.total !== undefined) { if (fix.total) t.total = true; else delete t.total; }
  if (fix.optional !== undefined) { if (fix.optional) t.optional = true; else delete t.optional; }
  if (fix.share !== undefined) { if (fix.share === 1) delete t.share; else t.share = fix.share; }
  return t;
}
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export interface ReviewRow {
  session_id: number; date: string; title: string; class_type: string; completion_pct: number | null; counted: string;
  not_counted: { block: string; movement: string; reason: string }[]; blocks_without_rounds: string[]; board_mentions: string[];
}

const MENTION = /partner|cash[ -]?out|\bpick\b|buy[ -]?in/i;

// What a class needs before its completion can be trusted: movements that can't be counted and why, blocks with no
// posted rounds, and every board line that mentions a partner, cash out, pick or buy in (the implementer re-reads those).
export async function reviewClasses(sql: Sql): Promise<ReviewRow[]> {
  const classes = await loadCompletionClasses(sql);
  const texts = new Map((await sql<{ id: string; board_text: string }[]>`select id::text, board_text from class_sessions`).map((r) => [Number(r.id), r.board_text]));
  return classes.map((c) => {
    const comp = classCompletion(c);
    const mentions = new Set<string>();
    for (const line of (texts.get(c.session_id) ?? "").split(/\r?\n/)) if (MENTION.test(line)) mentions.add(line.trim().slice(0, 200));
    return {
      session_id: c.session_id, date: c.date, title: c.title, class_type: c.class_type, completion_pct: comp.pct, counted: comp.counted,
      not_counted: comp.not_counted,
      blocks_without_rounds: c.blocks.filter((b) => b.format !== "amrap" && !(b.format === "sets" ? b.sets_max : b.rounds) && b.movements.some((m) => !m.target.total && !m.target.max)).map((b) => b.label),
      board_mentions: [...mentions],
    };
  });
}

export interface ApplyResult {
  applied: boolean; changes: { blocks: number; movements: number; planned: number; added: number; done_edits: number; excluded: number }; details: string[];
  completion: { session_id: number; title: string; date: string; before: number | null; after: number | null; counted_before: string; counted_after: string }[];
}

interface BlockRow { id: string; label: string; rounds: number | null }
interface MovRow { id: string; block_id: string; movement: string; position: number; target: Record<string, unknown>; done_sets: { reps?: number }[] | null }
interface PlannedDoc { blocks?: { label?: string; rounds?: number; movements?: { movement?: string; target?: Record<string, unknown> }[] }[] }

// done_reps for a per-side movement: each set's reps must be exactly double what is stored (or already double, which
// makes a second apply a no-op). Anything else stops the whole run, so a typo can never double a number twice.
function combinedDoneSets(done: { reps?: number }[], want: number[], where: string): { reps?: number }[] | null {
  if (done.length !== want.length) throw new ToolError(`${where}: it has ${done.length} sets stored but done_reps lists ${want.length}.`);
  let changed = false;
  const next = done.map((d, i) => {
    if (d.reps === undefined) throw new ToolError(`${where}: set ${i + 1} has no reps stored.`);
    if (want[i] === d.reps) return d;
    if (want[i] !== d.reps * 2) throw new ToolError(`${where}: set ${i + 1} has ${d.reps} reps stored, so done_reps must say ${d.reps * 2} (double) or ${d.reps} (leave it); got ${want[i]}.`);
    changed = true;
    return { ...d, reps: want[i] };
  });
  return changed ? next : null;
}

// The same doubling for the in-memory "after" column of the review table (the real write is checked in combinedDoneSets).
const combinedDoneSetsInMemory = <T extends { reps?: number }>(done: T[], want: number[]): T[] => done.map((d, i) => (want[i] !== undefined && d.reps !== undefined ? { ...d, reps: want[i] } : d));

export async function applyBoardFixes(sql: Sql, fixes: BoardFixes, opts: { apply: boolean }): Promise<ApplyResult> {
  const result: ApplyResult = { applied: opts.apply, changes: { blocks: 0, movements: 0, planned: 0, added: 0, done_edits: 0, excluded: 0 }, details: [], completion: [] };
  const stored = await loadCompletionClasses(sql);
  const writes: ((tx: Sql) => Promise<unknown>)[] = [];
  for (const cf of fixes.classes) {
    const [s] = await sql<{ id: string; title: string; planned: PlannedDoc | null; completion_excluded: string | null }[]>`select id::text, title, planned, completion_excluded from class_sessions where id = ${cf.session_id}`;
    if (!s) throw new ToolError(`class ${cf.session_id} was not found.`);
    const blocks = await sql<BlockRow[]>`select id::text, label, rounds from class_blocks where session_id = ${cf.session_id}`;
    const movs = await sql<MovRow[]>`select m.id::text, m.block_id::text, m.movement, m.position, m.target, m.done_sets from class_movements m join class_blocks b on b.id = m.block_id where b.session_id = ${cf.session_id}`;
    const planned: PlannedDoc = JSON.parse(JSON.stringify(s.planned ?? {}));
    let plannedChanged = false;
    const doneEdits = new Map<string, { reps?: number }[]>(); // movement id -> new done_sets, for the before/after table
    const addedByBlock = new Map<string, AddMovementFix[]>();
    for (const bf of cf.blocks) {
      const blk = blocks.find((b) => b.label === bf.label);
      if (!blk) throw new ToolError(`class ${cf.session_id} ("${s.title}"): block ${bf.label} was not found.`);
      const pb = planned.blocks?.find((b) => b.label === bf.label);
      if (bf.rounds !== undefined) {
        if (blk.rounds !== bf.rounds) {
          result.changes.blocks++; result.details.push(`class ${cf.session_id} block ${bf.label}: rounds ${blk.rounds ?? "none"} -> ${bf.rounds}`);
          writes.push((tx) => tx`update class_blocks set rounds = ${bf.rounds!} where id = ${blk.id}`);
        }
        if (pb && pb.rounds !== bf.rounds) { pb.rounds = bf.rounds; plannedChanged = true; }
      }
      for (const mf of bf.movements ?? []) {
        const key = normalize(mf.movement);
        const hits = movs.filter((m) => m.block_id === blk.id && normalize(m.movement) === key);
        if (hits.length === 0) throw new ToolError(`class ${cf.session_id}, block ${bf.label}: movement "${mf.movement}" was not found.`);
        for (const m of hits) {
          const next = patchTarget(m.target ?? {}, mf);
          if (!same(next, m.target ?? {})) {
            result.changes.movements++; result.details.push(`class ${cf.session_id} block ${bf.label} ${m.movement}: target ${JSON.stringify(m.target)} -> ${JSON.stringify(next)}`);
            writes.push((tx) => tx`update class_movements set target = ${tx.json(next as never)} where id = ${m.id}`);
          }
        }
        const pm = pb?.movements?.find((x) => normalize(x.movement ?? "") === key);
        if (pm) { const next = patchTarget(pm.target ?? {}, mf); if (!same(next, pm.target ?? {})) { pm.target = next; plannedChanged = true; } }
        if (mf.done_reps) {
          for (const m of hits) {
            const next = combinedDoneSets(m.done_sets ?? [], mf.done_reps, `class ${cf.session_id} block ${bf.label} ${m.movement}`);
            if (!next) continue;
            doneEdits.set(m.id, next);
            result.changes.done_edits++; result.details.push(`class ${cf.session_id} block ${bf.label} ${m.movement}: done reps ${(m.done_sets ?? []).map((d) => d.reps).join(", ")} -> ${next.map((d) => d.reps).join(", ")} (both sides combined)`);
            writes.push((tx) => tx`update class_movements set done_sets = ${tx.json(next as never)} where id = ${m.id}`);
          }
        }
      }
      // A skipped posted movement: stored with nothing done, so it counts as 0% of its posted work (not left out).
      let pos = Math.max(0, ...movs.filter((m) => m.block_id === blk.id).map((m) => m.position));
      for (const af of bf.add_movements ?? []) {
        if (movs.some((m) => m.block_id === blk.id && normalize(m.movement) === normalize(af.movement))) continue; // already there
        pos++;
        result.changes.added++; result.details.push(`class ${cf.session_id} block ${bf.label}: add ${af.movement} ${JSON.stringify(af.target)} with nothing done`);
        const at = pos;
        writes.push((tx) => tx`insert into class_movements (block_id, position, movement, target, done_sets, assumed) values (${blk.id}, ${at}, ${af.movement}, ${tx.json(af.target as never)}, ${tx.json([] as never)}, false)`);
        addedByBlock.set(bf.label, [...(addedByBlock.get(bf.label) ?? []), af]);
        if (pb) { pb.movements = [...(pb.movements ?? []), { movement: af.movement, target: af.target as Record<string, unknown> }]; plannedChanged = true; }
      }
    }
    // What the class's completion would be afterwards, computed in memory from the same patches (so the review table is real).
    const cur = stored.find((c) => c.session_id === cf.session_id);
    if (cur) {
      const patched: CClass = {
        ...cur,
        blocks: cur.blocks.map((b) => {
          const bf = cf.blocks.find((x) => x.label === b.label);
          if (!bf) return b;
          return {
            ...b, rounds: bf.rounds ?? b.rounds,
            movements: [
              ...b.movements.map((m) => {
                const mf = (bf.movements ?? []).find((x) => normalize(x.movement) === normalize(m.movement));
                if (!mf) return m;
                const done = mf.done_reps ? combinedDoneSetsInMemory(m.done_sets, mf.done_reps) : m.done_sets;
                return { ...m, done_sets: done, target: patchTarget(m.target as Record<string, unknown>, mf) as typeof m.target };
              }),
              ...(addedByBlock.get(b.label) ?? []).map((af) => ({ movement: af.movement, target: af.target as typeof b.movements[number]["target"], done_sets: [], variant_done: null, assumed: false })),
            ],
          };
        }),
      };
      if (cf.exclude_from_completion !== undefined) patched.excluded = cf.exclude_from_completion;
      const before = classCompletion(cur), after = classCompletion(patched);
      result.completion.push({ session_id: cur.session_id, title: cur.title, date: cur.date, before: before.pct, after: after.pct, counted_before: before.counted, counted_after: after.counted });
    }
    if (cf.exclude_from_completion !== undefined && s.completion_excluded !== cf.exclude_from_completion) {
      result.changes.excluded++; result.details.push(`class ${cf.session_id} (${s.title}): leave out of completion ("${cf.exclude_from_completion}")`);
      writes.push((tx) => tx`update class_sessions set completion_excluded = ${cf.exclude_from_completion!} where id = ${cf.session_id}`);
    }
    if (plannedChanged) {
      result.changes.planned++;
      writes.push((tx) => tx`update class_sessions set planned = ${tx.json(planned as never)} where id = ${cf.session_id}`);
    }
  }
  if (opts.apply && writes.length) await inTx(sql, async (tx) => { for (const w of writes) await w(tx); }); // all or nothing, on the transaction's own connection
  return result;
}
