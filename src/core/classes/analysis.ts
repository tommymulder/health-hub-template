import { loadCompletionClasses } from "../compare/classes";
import { classCompletion, completionTrends, finishTimeComparisons, normalizeClassName, type CBlock, type CClass, type CMovement } from "../compare/completion";
import { compareExercise, type ExerciseSession } from "../compare/exercise";
import { describeComparison } from "../compare/format";
import { loadSessionsForTemplates } from "../compare/load";
import type { ToolCtx } from "../tools/context";
import { lbToKg, type Units } from "../units";
import type { BlockInput, DoneSet, MovementInput } from "./types";

// The numbers a class coaching note is written from (Phase 19 D). Code computes every number; Claude writes the words
// from `analysis` only, so the note can't invent a comparison. No AI call is made here.
export interface AnalysisMovement { m: MovementInput; templateId: string | null; templateType: string | null; templateTitle: string; sets: DoneSet[]; assumed: boolean }
export interface AnalysisBlock { block: BlockInput; movements: AnalysisMovement[] }
export interface AnalysisInput { title: string; class_type: string; localDate: string; start: Date; blocks: AnalysisBlock[]; replaceId?: number }

export const NOTE_MAX = 1500;

export const NOTE_INSTRUCTIONS =
  "Write the coaching note in plain text from this analysis ONLY: every number must come from it, never from memory. " +
  "It is shown in the Hevy app, which has no markdown: use the emoji headers below, a blank line between sections, and one '•' line per item, each line short and starting with the exercise name. " +
  "Shape: (1) '📊 Board: ' one line on how it went, with board completion vs last time (example: '📊 Board: 82% done, up from 70% last BUILD Upper'). " +
  "(2) '✅ Did well' (3 bullets at most): PRs and clear improvements, with the numbers, from highlights.up. " +
  "(3) '🎯 Work on' (3 bullets at most): concrete small next steps from the numbers ('+5 lb', '1-2 more reps', 'one more round'), from highlights.down, for example '• Hollow hold: 10 s vs 40 s. Aim for 20 s next time.' " +
  "(4) '📈 Trend' (1-2 bullets), only where a trend exists ('• Squat estimated max up 8% over 6 sessions since September'). Leave out any section that has nothing in it. " +
  "(5) Say 'estimated' where the analysis says estimated. Never call a not_compared item worse (a different format or rep range is not worse). " +
  "Nothing medical, no heart rate, no recovery. At most 1,500 characters. Show it in the preview and send it as coaching_note after a clear yes.";

const toKg = (w: number, units: Units) => (units === "lb" ? lbToKg(w) : w);

function toCClass(a: AnalysisInput, units: Units): CClass {
  const blocks: CBlock[] = a.blocks.map(({ block, movements }) => ({
    label: block.label, format: block.format, sets_min: block.sets?.min ?? null, sets_max: block.sets?.max ?? null, rounds: block.rounds ?? null,
    finish_s: block.finish_s ?? null, sets_done: block.sets_done ?? null,
    movements: movements.map((pm): CMovement => ({
      movement: pm.m.movement, target: pm.m.target as CMovement["target"], variant_done: pm.m.variant_done ?? null, assumed: pm.assumed,
      done_sets: pm.sets.map((s) => ({
        ...(s.reps !== undefined ? { reps: s.reps } : {}), ...(s.weight !== undefined ? { weight_kg: toKg(s.weight, units) } : {}),
        ...(s.duration_s !== undefined ? { duration_s: s.duration_s } : {}), ...(s.distance_m !== undefined ? { distance_m: s.distance_m } : {}),
        ...(s.calories !== undefined ? { calories: s.calories } : {}),
      })),
    })),
  }));
  return { id: -1, title: a.title, class_type: a.class_type, date: a.localDate, blocks };
}

type Described = ReturnType<typeof describeComparison>;
const sizeOf = (d: Described) => Math.abs(d.change?.pct ?? 0);
// An estimated comparison (assumed sets on either side) still counts as a highlight, but it is labelled estimated.
const usable = (d: Described) => !d.first_time && !d.not_compared;
const highlight = (d: Described) => ({ exercise: d.exercise, line: d.line, verdict: d.verdict, ...(d.pr ? { pr: d.pr } : {}), ...(d.estimated ? { estimated: true as const } : {}), change_pct: d.change?.pct ?? null });

export async function analyzeClass(ctx: ToolCtx, a: AnalysisInput) {
  const cur = toCClass(a, ctx.units);
  const completion = classCompletion(cur);

  // ---- the class against the hub's stored classes
  const stored = await loadCompletionClasses(ctx.sql, { excludeId: a.replaceId });
  const name = normalizeClassName(a.title);
  const sameName = stored.filter((s) => normalizeClassName(s.title) === name && s.start_at < a.start);
  const lastSame = sameName[sameName.length - 1];
  const lastC = lastSame ? classCompletion(lastSame) : null;
  const vsLast = lastSame && lastC
    ? {
        title: lastSame.title, date: lastSame.date, last_pct: lastC.pct,
        change_points: completion.pct !== null && lastC.pct !== null ? Math.round((completion.pct - lastC.pct) * 10) / 10 : null,
        ...(lastC.estimated || completion.estimated ? { estimated: true } : {}),
        finish_times: finishTimeComparisons(cur, lastSame),
      }
    : { first_time: true as const };
  const points = [...stored.map((s) => ({ id: s.id, title: s.title, class_type: s.class_type, date: s.date, pct: classCompletion(s).pct })), { id: -1, title: a.title, class_type: a.class_type, date: a.localDate, pct: completion.pct }];
  const trends = completionTrends(points);

  // ---- each exercise against its own history (gym AND class), grouped by Hevy exercise
  const byTemplate = new Map<string, AnalysisMovement[]>();
  for (const b of a.blocks) for (const pm of b.movements) if (pm.sets.length > 0) {
    const key = pm.templateId ?? `new:${pm.templateTitle}`;
    byTemplate.set(key, [...(byTemplate.get(key) ?? []), pm]);
  }
  // Every exercise's history in two queries (not a pair per exercise: a class has a dozen).
  const histories = await loadSessionsForTemplates(ctx.sql, [...byTemplate.keys()].filter((k) => !k.startsWith("new:")), { before: a.start });
  const exercises: Described[] = [...byTemplate].map(([key, pms]) => {
    const first = pms[0];
    const complex = pms.map((p) => p.m.target.complex).find((c) => !!c) ?? null;
    const today: ExerciseSession = {
      wid: "new", date: a.localDate, where: "class", assumed: pms.some((p) => p.assumed), complex,
      calories: pms.reduce((n, p) => n + p.sets.reduce((x, s) => x + (s.calories ?? 0), 0), 0) || null,
      sets: pms.flatMap((p) => p.sets.map((s) => ({ set_type: s.type ?? "normal", weight_kg: s.weight !== undefined ? toKg(s.weight, ctx.units) : null, reps: s.reps ?? null, duration_s: s.duration_s ?? null, distance_m: s.distance_m ?? null }))),
    };
    const history = key.startsWith("new:") ? [] : (histories.get(key) ?? []);
    const c = compareExercise(today, history, { type: first.templateType, title: first.templateTitle });
    return describeComparison(c, today, history, { type: first.templateType, title: first.templateTitle, units: ctx.units });
  });

  const up = exercises.filter((d) => usable(d) && (d.pr || d.verdict === "better")).sort((x, y) => (y.pr ? 1000 : 0) + sizeOf(y) - ((x.pr ? 1000 : 0) + sizeOf(x))).slice(0, 3).map(highlight);
  const down = exercises.filter((d) => usable(d) && d.verdict === "worse").sort((x, y) => sizeOf(y) - sizeOf(x)).slice(0, 3).map(highlight);

  return {
    class: {
      completion: {
        pct: completion.pct, counted: completion.counted, blocks_finished: completion.blocks_finished, estimated: completion.estimated,
        blocks: completion.blocks.map((b) => ({ block: b.label, pct: b.pct, ...(b.finish_s ? { finish_s: b.finish_s } : {}), ...(b.amrap_reps_done !== undefined ? { amrap_reps_done: b.amrap_reps_done } : {}) })),
        not_counted: completion.not_counted, scaling: completion.scaling,
      },
      vs_last_same_class: vsLast,
      type_trend: trends.by_type.find((t) => t.class_type === a.class_type) ?? null,
      name_trend: trends.by_name.find((t) => t.name === name) ?? null,
    },
    exercises, highlights: { up, down }, note_instructions: NOTE_INSTRUCTIONS,
  };
}
export type ClassAnalysis = Awaited<ReturnType<typeof analyzeClass>>;

// Used when Claude sends no note: a short summary of the numbers (never the station list).
export function fallbackNote(an: ClassAnalysis): string {
  const c = an.class, v = c.vs_last_same_class;
  const lines: string[] = [];
  const pct = c.completion.pct;
  let head = pct === null ? "📊 Board: completion could not be counted" : `📊 Board: ${pct}% done (${c.completion.counted}${c.completion.blocks_finished.of ? `, ${c.completion.blocks_finished.finished} of ${c.completion.blocks_finished.of} blocks finished` : ""} counted)`;
  if ("first_time" in v) head += ", first time logged for this class";
  else if (v.last_pct !== null && pct !== null) head += v.change_points === 0 ? `, same as last ${v.title} (${v.last_pct}%)` : `, ${pct >= v.last_pct ? "up" : "down"} from ${v.last_pct}% last ${v.title}`;
  lines.push(head + (c.completion.estimated ? " (estimated)" : "") + ".");
  const section = (title: string, items: string[]) => { if (items.length) lines.push("", `${title}`, ...items.map((x) => `• ${x}`)); };
  section("✅ Did well", an.highlights.up.map((h) => h.line));
  section("🎯 Work on", an.highlights.down.map((h) => h.line));
  const firsts = an.exercises.filter((e) => e.first_time).map((e) => e.exercise);
  section("🆕 First time logged", firsts.slice(0, 6));
  return lines.join("\n").slice(0, NOTE_MAX);
}
