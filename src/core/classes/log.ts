import type { Sql } from "../db";
import { inTx } from "../db";
import { loadLocalTimeBatches, upsertWorkout } from "../hevy/sync";
import type { CustomExerciseBody, HevyWriteApi } from "../hevy/write";
import { localTime, localDateTime } from "../time";
import { lbToKg, outWeight, type Units } from "../units";
import { attempt, closeAudit, openAudit, pendingId, reserveWrite } from "../tools/audit";
import { ToolError, type ToolCtx } from "../tools/context";
import { ouraContextFor } from "../tools/ouraContext";
import { normalize } from "../match";
import { rememberAlias, resolveMovement, type Resolution } from "./aliases";
import { analyzeClass, fallbackNote, type AnalysisBlock } from "./analysis";
import { buildClassWorkout, classTitle, missingFor, type ResolvedBlock, type ResolvedMovement } from "./build";
import { deriveDoneSets, blockCount, type Derived } from "./derive";
import type { BlockInput, ClassInput, MovementInput } from "./types";
import { validateClassInput } from "./validate";
import { resolveClassWindow, type ClassWindow } from "./window";

const DUP_HOURS = 2;
const WEIGHTED_TYPES = ["weight_reps", "bodyweight_weighted"];

// type names differ between creating (POST) and reading (GET) a template
const READ_TYPE: Record<string, string> = {
  weight_reps: "weight_reps", reps_only: "reps_only", bodyweight_reps: "reps_only", bodyweight_assisted_reps: "bodyweight_assisted",
  duration: "duration", weight_duration: "weight_duration", distance_duration: "distance_duration", short_distance_weight: "short_distance_weight",
};

interface PlannedMovement { m: MovementInput; res: Resolution; derived: Derived; type: string | null }
interface PlannedBlock { block: BlockInput; movements: PlannedMovement[] }

async function plan(ctx: ToolCtx, input: ClassInput, forHevy: boolean): Promise<{ window: ClassWindow; blocks: PlannedBlock[] }> {
  const issues = validateClassInput(input);
  if (issues.length) throw new ToolError(`The class can't be logged yet. Fix these and call again (nothing was sent to Hevy):\n- ${issues.join("\n- ")}`);

  const window = await resolveClassWindow(ctx.sql, input, ctx.timezone, ctx.hrMax ?? 190);
  const problems: string[] = [];
  const blocks: PlannedBlock[] = [];
  for (const block of input.blocks) {
    const movements: PlannedMovement[] = [];
    for (const m of block.movements) {
      const res = await resolveMovement(ctx.sql, m);
      if (res.kind === "unresolved" && forHevy) problems.push(res.message);
      const derived = deriveDoneSets(block, m, input.completion_pct);
      const type = res.kind === "template" ? res.type : res.kind === "create" ? (READ_TYPE[res.body.exercise_type] ?? null) : null;
      if (type && WEIGHTED_TYPES.includes(type) && derived.sets.length > 0 && derived.sets.every((s) => s.weight === undefined)) {
        derived.assumed = true;
        derived.notes.push(`${m.movement}: no weight stated`);
      }
      // Hevy shows only the fields its exercise type has; a value in any other field is silently dropped (a 200 m ski
      // sent as reps showed as 0 mi), so stop and say what's missing instead.
      const missing = forHevy ? derived.sets.map((s) => missingFor(type, s)).find((x) => x !== null) : null;
      if (missing) problems.push(`"${m.movement}" is "${titleFor(res, m)}" in Hevy, which records ${missing} per set; give that in target or done_sets (reps alone would show as 0).`);
      movements.push({ m, res, derived, type });
    }
    blocks.push({ block, movements });
  }
  if (problems.length) throw new ToolError(`The class can't be logged yet. Fix these and call again (nothing was sent to Hevy):\n- ${problems.join("\n- ")}`);
  return { window, blocks };
}

const idFor = (res: Resolution): string => (res.kind === "template" ? res.id : res.kind === "create" ? `NEW:${res.body.title}` : "");
const titleFor = (res: Resolution, m: MovementInput): string => (res.kind === "template" ? res.title : res.kind === "create" ? res.body.title : m.movement);

function toResolvedBlocks(blocks: PlannedBlock[]): ResolvedBlock[] {
  return blocks.map((pb) => ({
    block: pb.block,
    movements: pb.movements.map((pm): ResolvedMovement => ({
      m: pm.m, templateId: idFor(pm.res), templateTitle: titleFor(pm.res, pm.m), templateType: pm.type, sets: pm.derived.sets, assumed: pm.derived.assumed, notes: pm.derived.notes,
    })),
  }));
}

function summarize(blocks: PlannedBlock[], units: Units) {
  return blocks.map((pb) => ({
    block: pb.block.label,
    exercises: pb.movements.map((pm) => ({
      movement: pm.m.movement,
      hevy_exercise: titleFor(pm.res, pm.m),
      matched_by: pm.res.kind === "template" ? pm.res.via : pm.res.kind === "create" ? "NEW custom exercise" : "unmatched",
      sets: pm.derived.sets.map((s) => ({
        ...(s.reps !== undefined ? { reps: s.reps } : {}),
        ...(s.weight !== undefined ? { weight: outWeight(units === "lb" ? lbToKg(s.weight) : s.weight, units) } : {}),
        ...(s.duration_s !== undefined ? { duration_s: s.duration_s } : {}),
        ...(s.distance_m !== undefined ? { distance_m: s.distance_m } : {}),
      })),
      ...(pm.derived.assumed ? { assumed: true } : {}),
    })),
  }));
}

const windowOut = (w: ClassWindow, tz: string) => ({
  start_local: localDateTime(w.start, tz), end_local: localTime(w.end, tz), minutes: Math.round((w.end.getTime() - w.start.getTime()) / 60_000), source: w.source, ...(w.detail ? { detail: w.detail } : {}),
});

export function extractWorkout(raw: unknown): { id: string; workout: unknown } | null {
  const w = (raw as { workout?: unknown } | null)?.workout ?? raw;
  const first = Array.isArray(w) ? w[0] : w;
  const id = (first as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? { id, workout: first } : null;
}
// Observed 2026-10-11: Hevy answers POST /v1/exercise_templates with a BARE JSON STRING (the new id, a UUID for custom
// exercises), not the {id: <integer>} the spec shows. Accept a string, a number, or the wrapped forms.
export function extractTemplateId(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  const r = raw as { id?: unknown; exercise_template?: { id?: unknown }; exercise?: { id?: unknown } } | null;
  const v = r?.id ?? r?.exercise_template?.id ?? r?.exercise?.id;
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
}

async function ouraSummary(ctx: ToolCtx, w: ClassWindow) {
  const o = (await ouraContextFor(ctx, { start_at: w.start, end_at: w.end, local_date: w.local_date })) as Record<string, unknown>;
  return o.connected === false ? { note: o.note } : { heart_rate: o.heart_rate, oura_workout: o.oura_workout };
}

// ---------------------------------------------------------------------------------------------------------------

const analysisBlocks = (blocks: PlannedBlock[], created: Map<string, string> = new Map()): AnalysisBlock[] => blocks.map((pb) => ({
  block: pb.block,
  movements: pb.movements.map((pm) => ({
    m: pm.m, templateType: pm.type, templateTitle: titleFor(pm.res, pm.m), sets: pm.derived.sets, assumed: pm.derived.assumed,
    templateId: pm.res.kind === "template" ? pm.res.id : pm.res.kind === "create" ? (created.get(pm.res.body.title) ?? null) : null,
  })),
}));

export async function logClassWorkout(ctx: ToolCtx, writer: HevyWriteApi, input: ClassInput, opts: { dry_run?: boolean } = {}) {
  const toHevy = input.log_to_hevy !== false;
  const { window, blocks } = await plan(ctx, input, toHevy);
  const title = classTitle(input);
  // The numbers the coaching note is written from. The real call recomputes them with the same rules as the dry run.
  const analysis = await analyzeClass(ctx, { title, class_type: input.class_type, localDate: window.local_date, start: window.start, blocks: analysisBlocks(blocks), replaceId: input.replaces_session_id });
  const note = input.coaching_note?.trim() ? { text: input.coaching_note.trim(), source: "coaching_note" as const } : { text: fallbackNote(analysis), source: "fallback" as const };
  const preview = buildClassWorkout({ input, blocks: toResolvedBlocks(blocks), start: window.start, end: window.end, units: ctx.units, description: note.text });
  const newCustom = blocks.flatMap((b) => b.movements.flatMap((m) => (m.res.kind === "create" ? [m.res.body] : [])));
  const assumptions = preview.assumptions;
  const warnings: string[] = [];
  if (window.source === "photo_time") warnings.push("No Oura record of this class was found, so the time is the photo time plus the default duration. Give start_at if you know it.");
  if (newCustom.length) warnings.push(`This will create ${newCustom.length} NEW custom exercise(s) in Hevy: ${newCustom.map((c) => c.title).join(", ")}. Custom exercises can never be edited or deleted afterwards.`);
  const replaced = input.replaces_session_id !== undefined ? await replaceable(ctx.sql, input.replaces_session_id) : null;
  if (replaced) warnings.push(`This REPLACES the hub's record of "${replaced.title}" on ${replaced.local_date} (its Hevy copy was deleted in the app).`);

  // ---- duplicate guard: another class within 2 hours of this one
  const lo = new Date(window.start.getTime() - DUP_HOURS * 3_600_000), hi = new Date(window.start.getTime() + DUP_HOURS * 3_600_000);
  const findDuplicate = async (tx: Sql) => {
    const [s] = await tx<{ id: string; title: string; hevy_workout_id: string | null }[]>`
      select id, title, hevy_workout_id from class_sessions where start_at between ${lo} and ${hi} and id <> ${replaced?.session_id ?? -1} order by start_at limit 1`;
    if (s) return { where: "the hub", session_id: Number(s.id), title: s.title, hevy_workout_id: s.hevy_workout_id };
    const [w] = await tx<{ hevy_id: string; outcome: string }[]>`
      select hevy_id, outcome from hevy_writes
      where kind = 'workout' and action = 'create' and outcome in ('pending', 'ok', 'unconfirmed')
        and (request->>'start_time')::timestamptz between ${lo} and ${hi}
        and hevy_id is distinct from ${replaced?.hevy_workout_id ?? null}
        -- a write whose Hevy workout the user deleted (and a sync saw it) is not a duplicate: on 2026-10-15 an earlier,
        -- deleted attempt blocked every redo of the class. Pending/unconfirmed writes still block (they may exist in Hevy).
        and not (outcome = 'ok' and exists (select 1 from workouts wk where wk.id = hevy_writes.hevy_id and wk.deleted))
      limit 1`;
    return w ? { where: "the audit log", session_id: null, title, hevy_workout_id: w.outcome === "ok" ? w.hevy_id : null, outcome: w.outcome } : null;
  };
  const dupMessage = (d: NonNullable<Awaited<ReturnType<typeof findDuplicate>>>) => ({
    already_logged: true, ...d,
    message: ("outcome" in d && d.outcome !== "ok")
      ? "An attempt to log a class at this time was made recently and its result is unconfirmed. Check your Hevy workout history before trying again."
      : d.where === "the hub"
        ? `A class at about this time is already logged (session_id ${d.session_id}), so I did not log it again. To REDO it: the user deletes its workout in the Hevy app, call sync_now with source hevy, then call again with replaces_session_id ${d.session_id}.`
        : "A class at about this time is already logged, so I did not log it again.",
  });

  if (opts.dry_run) {
    // Same duplicate check as the real run (without its lock), so a preview that passes means the real log will too.
    const dup = await findDuplicate(ctx.sql);
    if (dup) warnings.push(`The real log would be REFUSED: ${dupMessage(dup).message}`);
    return {
      dry_run: true,
      ...(dup ? { would_be_refused: dupMessage(dup) } : {}),
      message: "Preview only: nothing was sent to Hevy or saved. Show this to the user and get a clear yes before calling again without dry_run. Hevy workouts and custom exercises cannot be deleted through the API.",
      title, window: windowOut(window, ctx.timezone), units: ctx.units, log_to_hevy: toHevy, ...(replaced ? { replaces: replaced } : {}),
      blocks: summarize(blocks, ctx.units),
      new_custom_exercises: newCustom.map((c) => ({ title: c.title, exercise_type: c.exercise_type, muscle_group: c.muscle_group, equipment: c.equipment_category })),
      assumptions, not_logged: preview.skipped, warnings,
      analysis, note: { text: note.text, source: note.source },
      ...(note.source === "fallback" ? { note_hint: "No coaching_note was given, so this short summary of the numbers would be the Hevy description. Write a coaching note from `analysis` (see analysis.note_instructions), show it in the preview, and send it as coaching_note after a clear yes." } : {}),
      oura: await ouraSummary(ctx, window),
    };
  }

  let auditId: number | null = null;
  if (toHevy) {
    const r = await reserveWrite(ctx.sql, { lockKey: `hevy_write:class:${window.local_date}`, kind: "workout", title, request: preview.body, findDuplicate });
    if (r.existing) return dupMessage(r.existing);
    auditId = r.auditId;
  } else {
    const dup = await inTx(ctx.sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`hevy_write:class:${window.local_date}`}, 0))`;
      return findDuplicate(tx);
    });
    if (dup) return dupMessage(dup);
  }

  const reject = async (message: string): Promise<never> => {
    if (auditId !== null) await closeAudit(ctx.sql, auditId, "rejected", { response: { error: message } });
    throw new ToolError(message);
  };

  // ---- 1. any NEW custom exercises (each is permanent), one at a time, each recorded before and after
  const created = new Map<string, string>(); // title -> id
  if (toHevy) {
    for (const body of newCustom) {
      const cAudit = await openAudit(ctx.sql, { kind: "exercise_template", action: "create", hevyId: pendingId(), title: body.title, request: body });
      try {
        const { raw } = await attempt(ctx.sql, cAudit, { what: "create", thing: `custom exercise "${body.title}"`, whereToLook: "your exercise list in Hevy" }, () => writer.createExerciseTemplate(body));
        const id = extractTemplateId(raw);
        await closeAudit(ctx.sql, cAudit, "ok", { hevyId: id ?? `unknown:${pendingId()}`, response: raw });
        if (!id) return await reject(`Created the custom exercise "${body.title}" but couldn't read its id. Run sync_now, then call me again: it will find the exercise by name. Nothing else was sent.`);
        await saveCustomTemplate(ctx.sql, id, body);
        created.set(body.title, id);
      } catch (err) {
        if (err instanceof ToolError && auditId !== null) await closeAudit(ctx.sql, auditId, "rejected", { response: { error: `custom exercise step failed: ${err.message}` } });
        throw err;
      }
    }
  }

  // ---- 2. the final payload, with real template ids
  const finalBlocks = toResolvedBlocks(blocks).map((rb) => ({
    ...rb,
    movements: rb.movements.map((rm) => ({ ...rm, templateId: rm.templateId.startsWith("NEW:") ? (created.get(rm.templateId.slice(4)) ?? rm.templateId) : rm.templateId })),
  }));
  const built = buildClassWorkout({ input, blocks: finalBlocks, start: window.start, end: window.end, units: ctx.units, description: note.text });
  if (toHevy && built.body.exercises.length === 0) return await reject("Nothing in this class has countable sets, so there is nothing to log. Give the sets/reps or sets_done, or use log_to_hevy: false.");
  if (toHevy && built.body.exercises.some((e) => e.exercise_template_id.startsWith("NEW:"))) return await reject("A custom exercise wasn't created, so the workout was not sent.");

  // ---- 3. the finished workout (ONE attempt)
  let hevyId: string | null = null;
  let hevyWorkout: unknown = null;
  if (toHevy) {
    await ctx.sql`update hevy_writes set request = ${ctx.sql.json(built.body as never)} where id = ${auditId}`;
    const { raw } = await attempt(ctx.sql, auditId!, { what: "create", thing: "workout", whereToLook: "your workout history in Hevy" }, () => writer.createWorkout(built.body));
    const found = extractWorkout(raw);
    hevyId = found?.id ?? null;
    hevyWorkout = found?.workout ?? null;
    const w = await closeAudit(ctx.sql, auditId!, "ok", { hevyId: hevyId ?? `unknown:${pendingId()}`, response: raw });
    if (w) warnings.push(w);
    if (!hevyId) warnings.push("Hevy created the workout but its reply had no id; it is in your history but not linked to the hub's class record.");
  }

  // ---- 4. the hub's own record (the full truth: planned vs done), and show the new workout to the read tools straight away
  let sessionId: number | null = null;
  try {
    if (hevyWorkout) await upsertWorkout(ctx.sql, hevyWorkout as never, ctx.timezone, await loadLocalTimeBatches(ctx.sql));
  } catch (err) {
    warnings.push(`The workout is in Hevy but couldn't be copied into the hub yet (${(err as Error).message}); the next sync will bring it in.`);
  }
  try {
    sessionId = await saveHubRecord(ctx.sql, { input, window, title, blocks, created, hevyId, units: ctx.units, replaceId: replaced?.session_id, coachingNote: note.text });
  } catch (err) {
    warnings.push(`${toHevy ? "The workout is in Hevy, but" : ""} the hub's class record could not be saved (${(err as Error).message}).`);
  }

  // ---- 5. remember what matched what, so next time the same board words land on the same exercise
  for (const pb of blocks) for (const pm of pb.movements) {
    const id = pm.res.kind === "template" ? pm.res.id : pm.res.kind === "create" ? created.get(pm.res.body.title) : undefined;
    if (id && !(pm.res.kind === "template" && pm.res.via === "remembered")) await rememberAlias(ctx.sql, pm.m.movement, id).catch(() => undefined);
  }

  return {
    logged: true, title, window: windowOut(window, ctx.timezone), units: ctx.units,
    hevy: toHevy ? { workout_id: hevyId, exercises: built.body.exercises.length, sets: built.body.exercises.reduce((n, e) => n + e.sets.length, 0) } : null,
    hub: { class_session_id: sessionId, ...(replaced ? { replaced_session_id: replaced.session_id } : {}) },
    blocks: summarize(blocks, ctx.units),
    analysis, note: { text: note.text, source: note.source },
    new_custom_exercises: [...created.entries()].map(([t, id]) => ({ title: t, id })),
    assumptions: built.assumptions, not_logged: built.skipped, warnings,
    oura: await ouraSummary(ctx, window),
    message: toHevy ? "Logged to Hevy as a finished workout and saved in the hub. To remove the Hevy copy, delete it in the Hevy app (the API cannot delete)." : "Saved in the hub only (not sent to Hevy).",
  };
}

// Redo a class: allowed ONLY when its Hevy copy is gone (the user deleted it in the app and a sync marked it deleted),
// so a replacement can never leave two copies of one class in Hevy. The hub's old record is then swapped for the new one.
async function replaceable(sql: Sql, id: number) {
  const [s] = await sql<{ id: string; title: string; local_date: string; hevy_workout_id: string | null }[]>`
    select id, title, local_date::text as local_date, hevy_workout_id from class_sessions where id = ${id}`;
  if (!s) throw new ToolError(`replaces_session_id ${id}: there is no class with that id in the hub (get_class_history lists classes with their session_id).`);
  if (s.hevy_workout_id) {
    const [w] = await sql<{ deleted: boolean }[]>`select deleted from workouts where id = ${s.hevy_workout_id}`;
    if (!w?.deleted) {
      throw new ToolError(`"${s.title}" on ${s.local_date} is still in Hevy as far as the hub knows. Ask the user to delete it in the Hevy app, then call sync_now with source hevy and try again (this stops two copies of the class ending up in Hevy). Nothing was sent.`);
    }
  }
  return { session_id: Number(s.id), title: s.title, local_date: s.local_date, hevy_workout_id: s.hevy_workout_id };
}

async function saveCustomTemplate(sql: Sql, id: string, b: CustomExerciseBody) {
  await sql`
    insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at)
    values (${id}, ${b.title}, ${READ_TYPE[b.exercise_type] ?? b.exercise_type}, ${b.muscle_group}, ${sql.json(b.other_muscles as never)}, ${b.equipment_category}, true, now())
    on conflict (id) do update set title = excluded.title, type = excluded.type, primary_muscle = excluded.primary_muscle,
      secondary_muscles = excluded.secondary_muscles, equipment = excluded.equipment, is_custom = true, updated_at = now()`;
}

async function saveHubRecord(
  sql: Sql,
  a: { input: ClassInput; window: ClassWindow; title: string; blocks: PlannedBlock[]; created: Map<string, string>; hevyId: string | null; units: Units; replaceId?: number; coachingNote: string },
): Promise<number> {
  const { input, window } = a;
  const toKg = (w: number) => (a.units === "lb" ? lbToKg(w) : w);
  return inTx(sql, async (tx) => {
    if (a.replaceId !== undefined) await tx`delete from class_sessions where id = ${a.replaceId}`; // blocks and movements cascade
    const [s] = await tx<{ id: string }[]>`
      insert into class_sessions (gym, class_type, title, start_at, end_at, window_source, local_date, board_text, planned, completion_pct, precision, user_notes, hevy_workout_id, coaching_note)
      values (${input.gym}, ${input.class_type}, ${a.title}, ${window.start}, ${window.end}, ${window.source}, ${window.local_date}, ${input.board_text},
              ${tx.json({ gym: input.gym, class_type: input.class_type, blocks: input.blocks } as never)}, ${input.completion_pct ?? null}, ${input.precision}, ${input.user_notes ?? null}, ${a.hevyId}, ${a.coachingNote})
      returning id`;
    for (const pb of a.blocks) {
      const b = pb.block;
      const [blk] = await tx<{ id: string }[]>`
        insert into class_blocks (session_id, label, format, sets_min, sets_max, interval_s, rounds, time_cap_s, sets_done)
        values (${s.id}, ${b.label}, ${b.format}, ${b.sets?.min ?? null}, ${b.sets?.max ?? null}, ${b.interval_s ?? null}, ${b.rounds ?? null}, ${b.time_cap_s ?? null},
                ${blockCount(b, input.completion_pct).count})
        returning id`;
      for (const [i, pm] of pb.movements.entries()) {
        const tplId = pm.res.kind === "template" ? pm.res.id : pm.res.kind === "create" ? (a.created.get(pm.res.body.title) ?? null) : null;
        const doneKg = pm.derived.sets.map((d) => ({
          ...(d.reps !== undefined ? { reps: d.reps } : {}),
          ...(d.weight !== undefined ? { weight_kg: toKg(d.weight) } : {}),
          ...(d.duration_s !== undefined ? { duration_s: d.duration_s } : {}),
          ...(d.distance_m !== undefined ? { distance_m: d.distance_m } : {}),
          ...(d.calories !== undefined ? { calories: d.calories } : {}), // hub only: Hevy has no calories field
        }));
        await tx`
          insert into class_movements (block_id, position, movement, exercise_template_id, target, variant_done, done_sets, assumed)
          values (${blk.id}, ${i}, ${normalize(pm.m.movement)}, ${tplId}, ${tx.json(pm.m.target as never)}, ${pm.m.variant_done ?? null}, ${tx.json(doneKg as never)}, ${pm.derived.assumed})`;
      }
    }
    return Number(s.id);
  });
}

