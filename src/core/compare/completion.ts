// Board completion (Phase 19 C): how much of the posted work was done. Pure: no database, no Next imports (DESIGN D9).
// Computed when read from stored facts, never stored, so a better rule (or a fixed partner split) recalculates every past
// class. NOT COUNTABLE is never 0: unknown work is left out and listed with the reason.

export interface CTarget {
  reps?: number | { min: number; max: number }; reps_by_set?: number[]; per_side?: boolean; complex?: string;
  duration_s?: number; distance_m?: number; calories?: number; max?: boolean;
  total?: boolean; share?: number; optional?: boolean; alternatives?: { label: string }[];
}
export interface CDone { reps?: number; weight_kg?: number; duration_s?: number; distance_m?: number; calories?: number }
export interface CMovement { movement: string; target: CTarget; done_sets: CDone[]; variant_done: string | null; assumed: boolean }
export interface CBlock {
  label: string; format: string; sets_min: number | null; sets_max: number | null; rounds: number | null; finish_s: number | null; sets_done?: number | null; movements: CMovement[];
}
export interface CClass { id: number; title: string; class_type: string; date: string; blocks: CBlock[]; excluded?: string | null } // excluded = why this class is left out of completion (e.g. a board rebuilt from memory)

export const THRESHOLD_POINTS = 5; // a verdict needs a change of at least 5 percentage points...
export const MIN_CLASSES = 8; // ...and at least 8 countable classes
const FINISH_TIME_PCT = 5;

type Unit = "reps" | "m" | "s" | "cal";
const UNIT_WORD: Record<Unit, string> = { reps: "reps", m: "meters", s: "seconds", cal: "calories" };
const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

export type MovementResult =
  | { block: string; movement: string; countable: true; unit: Unit; posted: number; done: number; pct: number; estimated?: true }
  | { block: string; movement: string; countable: false; reason: string; reps_done?: number };

export interface BlockCompletion {
  label: string; format: string; pct: number | null; finished: boolean | null; movements: MovementResult[];
  finish_s?: number; amrap_reps_done?: number; rounds_done?: number;
}
export interface ClassCompletion {
  pct: number | null; counted: string; counted_movements: number; total_movements: number;
  blocks: BlockCompletion[]; blocks_finished: { finished: number; of: number };
  not_counted: { block: string; movement: string; reason: string }[];
  scaling: { rx_done: number; rx_posted: number }; estimated: boolean; excluded?: string;
}

function boardUnit(t: CTarget): Unit | null {
  if (t.calories !== undefined) return "cal"; // calories posted wins over the estimated distance kept for Hevy
  if (t.distance_m !== undefined) return "m";
  if (t.duration_s !== undefined) return "s";
  if (t.reps !== undefined || t.reps_by_set?.length) return "reps";
  return null;
}
function doneUnits(done: CDone[]): Unit[] {
  const u: Unit[] = [];
  if (done.some((d) => d.reps !== undefined)) u.push("reps");
  if (done.some((d) => d.distance_m !== undefined)) u.push("m");
  if (done.some((d) => d.duration_s !== undefined)) u.push("s");
  if (done.some((d) => d.calories !== undefined)) u.push("cal");
  return u;
}
const doneAmount = (done: CDone[], u: Unit) => sum(done.map((d) => (u === "reps" ? d.reps : u === "m" ? d.distance_m : u === "s" ? d.duration_s : d.calories)));

// A range counts at its top: the board's full ask.
const repsTop = (r: CTarget["reps"]): number | undefined => (typeof r === "number" ? r : r ? r.max : undefined);

function postedRounds(b: CBlock): number | null {
  const r = b.format === "sets" ? b.sets_max : b.rounds;
  return r && r > 0 ? r : null;
}

function movementCompletion(b: CBlock, m: CMovement): MovementResult {
  const base = { block: b.label, movement: m.movement };
  const t = m.target, done = m.done_sets ?? [];
  const no = (reason: string, extra: { reps_done?: number } = {}): MovementResult => ({ ...base, countable: false, reason, ...extra });

  if (b.format === "amrap") return no("AMRAP: there is no posted ceiling, so the rounds or reps done are reported instead");
  if (t.max) return no("a max-reps target has no ceiling, so reps done are reported instead", { reps_done: sum(done.map((d) => d.reps)) });
  const nothingDone = done.length === 0 || doneUnits(done).every((u) => doneAmount(done, u) === 0);
  if (t.optional && nothingDone) return no("optional movement, not done");

  const unit = boardUnit(t);
  if (!unit) return no("the board gave no number to count");
  const rounds = postedRounds(b);
  if (!t.total && rounds === null) return no("no posted rounds, so the posted work can't be counted");

  const share = t.share ?? 1;
  const side = t.per_side ? 2 : 1; // per-side reps are already stored as a total by the class logger
  let perRound: number;
  if (t.total) {
    perRound = unit === "reps" ? (t.reps_by_set?.length ? sum(t.reps_by_set) : (repsTop(t.reps) ?? 0)) * side : (unit === "m" ? t.distance_m : unit === "s" ? t.duration_s : t.calories) ?? 0;
  } else if (unit === "reps" && t.reps_by_set?.length) {
    const rb = t.reps_by_set;
    perRound = Array.from({ length: rounds! }, (_, i) => rb[Math.min(i, rb.length - 1)]).reduce((a, x) => a + x, 0) * side;
  } else {
    const one = unit === "reps" ? (repsTop(t.reps) ?? 0) * side : (unit === "m" ? t.distance_m : unit === "s" ? t.duration_s : t.calories) ?? 0;
    perRound = one * rounds!;
  }
  const posted = perRound * share;
  if (!(posted > 0)) return no("the posted amount is zero");

  const got = doneUnits(done);
  if (done.length > 0 && !got.includes(unit)) {
    return no(`the board counts ${UNIT_WORD[unit]}, but only ${got.map((u) => UNIT_WORD[u]).join(" and ") || "nothing countable"} were logged (the hub never converts between units)`);
  }
  const amount = doneAmount(done, unit);
  return { ...base, countable: true, unit, posted: round1(posted), done: round1(amount), pct: round1(Math.min(100, (amount / posted) * 100)), ...(m.assumed ? { estimated: true as const } : {}) };
}

// RX is counted only where the board posted an alternative LABELLED RX; a "sub" or "scaled" option is not an RX posting.
const isRxLabel = (label: string) => label.trim().toLowerCase() === "rx";
const postsRx = (m: CMovement) => (m.target.alternatives ?? []).some((a) => isRxLabel(a.label));
const isRx = (m: CMovement) => isRxLabel(m.variant_done ?? "");

export function classCompletion(c: CClass): ClassCompletion {
  // A class whose board can't be trusted has NO completion (never 0): every average and trend skips it.
  if (c.excluded) {
    return { pct: null, counted: `excluded (${c.excluded})`, counted_movements: 0, total_movements: c.blocks.reduce((n, b) => n + b.movements.length, 0), blocks: [], blocks_finished: { finished: 0, of: 0 }, not_counted: [], scaling: { rx_done: 0, rx_posted: 0 }, estimated: false, excluded: c.excluded };
  }
  const blocks: BlockCompletion[] = c.blocks.map((b) => {
    const movements = b.movements.map((m) => movementCompletion(b, m));
    const counted = movements.filter((x): x is Extract<MovementResult, { countable: true }> => x.countable);
    const pct = counted.length ? round1(counted.reduce((a, x) => a + x.pct, 0) / counted.length) : null;
    return {
      label: b.label, format: b.format, pct, movements,
      finished: counted.length ? counted.every((x) => x.pct >= 100) : null,
      ...(b.finish_s ? { finish_s: b.finish_s } : {}),
      ...(b.format === "amrap" ? { amrap_reps_done: sum(b.movements.flatMap((m) => (m.done_sets ?? []).map((d) => d.reps))), ...(b.sets_done ? { rounds_done: b.sets_done } : {}) } : {}),
    };
  });
  const all = blocks.flatMap((b) => b.movements);
  const countableBlocks = blocks.filter((b) => b.pct !== null);
  const countedMovements = all.filter((m) => m.countable);
  const rxPosted = c.blocks.flatMap((b) => b.movements).filter(postsRx);
  return {
    pct: countableBlocks.length ? round1(countableBlocks.reduce((a, b) => a + (b.pct as number), 0) / countableBlocks.length) : null,
    counted: `${countedMovements.length} of ${all.length} movements`, counted_movements: countedMovements.length, total_movements: all.length,
    blocks,
    blocks_finished: { finished: countableBlocks.filter((b) => b.finished).length, of: countableBlocks.length },
    not_counted: all.filter((m): m is Extract<MovementResult, { countable: false }> => !m.countable).map((m) => ({ block: m.block, movement: m.movement, reason: m.reason })),
    scaling: { rx_done: rxPosted.filter(isRx).length, rx_posted: rxPosted.length },
    estimated: countedMovements.some((m) => m.countable && m.estimated === true),
  };
}

// "BUILD - Upper Body" and "build  upper body" are the same class.
export const normalizeClassName = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface FinishComparison { block: string; finish_s: number; last_finish_s: number; change_s: number; change_pct: number; verdict: "better" | "worse" | "same" }

// A for_time block they finished, against the same block of the last class of the same name (a lower time is better).
export function finishTimeComparisons(current: CClass, previous: CClass | null): FinishComparison[] {
  if (!previous) return [];
  const out: FinishComparison[] = [];
  for (const b of current.blocks) {
    if (b.format !== "for_time" || !b.finish_s) continue;
    const last = previous.blocks.find((x) => x.label === b.label && x.format === "for_time" && x.finish_s);
    if (!last?.finish_s) continue;
    const pct = ((b.finish_s - last.finish_s) / last.finish_s) * 100;
    out.push({ block: b.label, finish_s: b.finish_s, last_finish_s: last.finish_s, change_s: b.finish_s - last.finish_s, change_pct: round1(pct), verdict: Math.abs(pct) < FINISH_TIME_PCT ? "same" : pct < 0 ? "better" : "worse" });
  }
  return out;
}

export interface CompletionPoint { id: number; title: string; class_type: string; date: string; pct: number | null }
export interface CompletionTrends {
  by_name: { name: string; title: string; classes: number; last: number; previous: number; change_points: number; verdict: "better" | "worse" | "same" | null }[];
  by_type: { class_type: string; countable_classes: number; last4_avg: number | null; previous4_avg: number | null; change_points: number | null; verdict: "better" | "worse" | "same" | null }[];
}

const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const verdictFor = (change: number, enough: boolean): "better" | "worse" | "same" | null => (!enough ? null : Math.abs(change) < THRESHOLD_POINTS ? "same" : change > 0 ? "better" : "worse");

// Compared with the last class of the same name, and (per class type) the last 4 classes' average against the 4 before.
// A verdict needs at least 8 countable classes and a 5-point change; otherwise only the numbers are shown.
export function completionTrends(points: CompletionPoint[]): CompletionTrends {
  const ok = points.filter((p): p is CompletionPoint & { pct: number } => p.pct !== null).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const names = new Map<string, typeof ok>();
  for (const p of ok) names.set(normalizeClassName(p.title), [...(names.get(normalizeClassName(p.title)) ?? []), p]);
  const types = new Map<string, typeof ok>();
  for (const p of ok) types.set(p.class_type, [...(types.get(p.class_type) ?? []), p]);
  // Same gate as the type trend: 8 countable classes OF THAT TYPE (a verdict from two classes of one name is noise).
  const by_name = [...names].filter(([, v]) => v.length >= 2).map(([name, v]) => {
    const last = v[v.length - 1].pct, previous = v[v.length - 2].pct, type = v[v.length - 1].class_type;
    return { name, title: v[v.length - 1].title, classes: v.length, last, previous, change_points: round1(last - previous), verdict: verdictFor(last - previous, (types.get(type)?.length ?? 0) >= MIN_CLASSES) };
  });
  const by_type = [...types].map(([class_type, v]) => {
    const last4 = v.slice(-4).map((x) => x.pct), prev4 = v.slice(-8, -4).map((x) => x.pct);
    const l = avg(last4), p = avg(prev4);
    const change = l !== null && p !== null ? round1(l - p) : null;
    return { class_type, countable_classes: v.length, last4_avg: l, previous4_avg: p, change_points: change, verdict: change === null ? null : verdictFor(change, v.length >= MIN_CLASSES) };
  });
  return { by_name, by_type };
}
