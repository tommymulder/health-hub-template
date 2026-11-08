import { randomUUID } from "node:crypto";
import type { Sql } from "../db";
import { attempt, closeAudit, openAudit, pendingId, reserveWrite } from "./audit";
import { lev } from "../match";
import { HevyWriteError, type HevyWriteApi, type RoutineBody } from "../hevy/write";
import { lbToKg, outWeight, type Units } from "../units";
import { ToolError, type ToolCtx } from "./context";

// Writing to Hevy is irreversible through the API (no delete), so every write goes:
//   validate -> double-submit guard + write-ahead audit row -> ONE attempt -> finalise audit row.
export const CLAUDE_FOLDER = "Claude";
const GUARD_MINUTES = 10;
const MAX_EXERCISES = 30, MAX_SETS = 20, MAX_REST_S = 600, MAX_REPS = 200, MAX_DURATION_S = 86_400;
const MAX_WEIGHT_KG = 700; // sanity bound (~1,540 lb): catches a typo, not a real lift
const SET_TYPES = ["warmup", "normal", "failure", "dropset"];

export interface RoutineSetInput { type?: string; weight?: number | null; reps?: number | null; duration_s?: number | null }
export interface RoutineExerciseInput { exercise_template_id: string; rest_seconds?: number | null; notes?: string | null; sets: RoutineSetInput[] }
export interface RoutineInput { title: string; notes?: string | null; exercises: RoutineExerciseInput[] }

type Body = Omit<RoutineBody, "folder_id">;
export interface Prepared {
  body: Body;
  preview: { title: string; notes: string | null; exercises: { title: string; template_id: string; rest_seconds: number | null; notes: string | null; sets: Record<string, unknown>[] }[] };
  warnings: string[];
}

const toKg = (w: number, units: Units) => (units === "lb" ? lbToKg(w) : w); // full precision, NO rounding

// ---- validation + unit conversion (at the boundary) ------------------------

export async function prepareRoutine(ctx: ToolCtx, input: RoutineInput): Promise<Prepared> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const title = (input.title ?? "").trim();
  if (!title) issues.push("title is required.");
  if (title.length > 100) issues.push("title is too long (max 100 characters).");
  if (!Array.isArray(input.exercises) || input.exercises.length === 0) issues.push("at least one exercise is required.");
  if ((input.exercises?.length ?? 0) > MAX_EXERCISES) issues.push(`too many exercises (max ${MAX_EXERCISES}).`);

  const exercises = (input.exercises ?? []).slice(0, MAX_EXERCISES);
  const ids = [...new Set(exercises.map((e) => e.exercise_template_id).filter(Boolean))];
  const known = new Map<string, { title: string; type: string | null }>();
  if (ids.length > 0) {
    const rows = await ctx.sql<{ id: string; title: string; type: string | null }[]>`
      select id, title, type from exercise_templates where id in ${ctx.sql(ids)}`;
    for (const r of rows) known.set(r.id, { title: r.title, type: r.type });
  }
  let allTemplates: { id: string; title: string }[] | undefined;

  const bodyExercises: Body["exercises"] = [];
  const previewExercises: Prepared["preview"]["exercises"] = [];

  for (const [i, e] of exercises.entries()) {
    const tpl = known.get(e.exercise_template_id);
    const label = `exercise ${i + 1}${tpl ? ` (${tpl.title})` : ""}`;
    if (!tpl) {
      allTemplates ??= await ctx.sql<{ id: string; title: string }[]>`select id, title from exercise_templates`;
      const near = allTemplates
        .map((t) => ({ t, d: lev(e.exercise_template_id.toUpperCase(), t.id.toUpperCase()) }))
        .filter((x) => x.d <= 3).sort((a, b) => a.d - b.d).slice(0, 3)
        .map((x) => `${x.t.id} = ${x.t.title}`);
      issues.push(`${label}: exercise_template_id "${e.exercise_template_id}" doesn't exist.` +
        (near.length ? ` Closest ids: ${near.join("; ")}.` : "") + " Use search_exercises to get a real id.");
      continue;
    }
    if (e.rest_seconds != null && (!Number.isInteger(e.rest_seconds) || e.rest_seconds < 0 || e.rest_seconds > MAX_REST_S))
      issues.push(`${label}: rest_seconds must be a whole number from 0 to ${MAX_REST_S}.`);
    if (!Array.isArray(e.sets) || e.sets.length === 0) { issues.push(`${label}: needs at least one set.`); continue; }
    if (e.sets.length > MAX_SETS) issues.push(`${label}: too many sets (max ${MAX_SETS}).`);

    const kind = tpl.type ?? "weight_reps";
    if (["short_distance_weight", "distance_duration", "steps_duration", "floors_duration"].includes(kind)) {
      issues.push(`${label}: this is a ${kind} exercise, which this tool can't build yet. Leave it out and add it in the Hevy app.`);
      continue;
    }
    const needsDuration = kind === "duration";
    let unweighted = false;

    const sets = e.sets.slice(0, MAX_SETS).map((s, j) => {
      const sl = `${label}, set ${j + 1}`;
      const type = s.type ?? "normal";
      if (!SET_TYPES.includes(type)) issues.push(`${sl}: type must be one of ${SET_TYPES.join(", ")}.`);
      let kg: number | null = null;
      if (s.weight != null) {
        if (!Number.isFinite(s.weight) || s.weight < 0) issues.push(`${sl}: weight must be 0 or more.`);
        else {
          kg = toKg(s.weight, ctx.units);
          if (kg > MAX_WEIGHT_KG) issues.push(`${sl}: weight ${s.weight} ${ctx.units} looks like a typo.`);
        }
      }
      if (s.reps != null && (!Number.isInteger(s.reps) || s.reps < 1 || s.reps > MAX_REPS)) issues.push(`${sl}: reps must be a whole number from 1 to ${MAX_REPS}.`);
      if (s.duration_s != null && (!Number.isInteger(s.duration_s) || s.duration_s < 1 || s.duration_s > MAX_DURATION_S)) issues.push(`${sl}: duration_s must be a whole number of seconds (1 to ${MAX_DURATION_S}).`);
      if (needsDuration && s.duration_s == null) issues.push(`${sl}: ${tpl.title} is timed, so give duration_s.`);
      if (!needsDuration && s.reps == null && s.duration_s == null) issues.push(`${sl}: give reps.`);
      if (!needsDuration && kind !== "weight_reps" && kind !== "bodyweight_weighted" && kind !== "bodyweight_assisted" && kg !== null && kg > 0 && kind === "reps_only")
        warnings.push(`${tpl.title} counts reps only; the weight on set ${j + 1} will not be tracked.`);
      if ((kind === "weight_reps" || kind === "bodyweight_weighted") && s.weight == null) unweighted = true;
      return { type, weight_kg: kg, reps: s.reps ?? null, duration_seconds: s.duration_s ?? null };
    });
    if (unweighted) warnings.push(`${tpl.title}: some sets have no weight, so Hevy will show them empty.`);

    bodyExercises.push({ exercise_template_id: e.exercise_template_id, superset_id: null, rest_seconds: e.rest_seconds ?? null, notes: e.notes ?? null, sets });
    previewExercises.push({
      title: tpl.title, template_id: e.exercise_template_id, rest_seconds: e.rest_seconds ?? null, notes: e.notes ?? null,
      sets: sets.map((s) => ({ type: s.type, ...(s.weight_kg !== null ? { weight: outWeight(s.weight_kg, ctx.units) } : {}), ...(s.reps !== null ? { reps: s.reps } : {}), ...(s.duration_seconds !== null ? { duration_s: s.duration_seconds } : {}) })),
    });
  }

  if (issues.length > 0) throw new ToolError(`The routine can't be created yet. Fix these and call again (nothing was sent to Hevy):\n- ${issues.join("\n- ")}`);
  return {
    body: { title, notes: input.notes?.trim() || null, exercises: bodyExercises },
    preview: { title, notes: input.notes?.trim() || null, exercises: previewExercises },
    warnings: [...new Set(warnings)],
  };
}

// ---- the Claude folder ------------------------------------------------------

async function ensureClaudeFolder(sql: Sql, writer: HevyWriteApi): Promise<number> {
  const [cached] = await sql<{ value: string }[]>`select value from settings where key = 'hevy_claude_folder_id'`;
  if (cached) return Number(cached.value);

  const remember = async (id: number) => {
    await sql`insert into settings (key, value) values ('hevy_claude_folder_id', ${String(id)})
              on conflict (key) do update set value = excluded.value`;
    return id;
  };
  const existing = (await writer.listRoutineFolders()).find((f) => f.title === CLAUDE_FOLDER);
  if (existing) return remember(existing.id);

  const auditId = await openAudit(sql, { kind: "routine_folder", action: "create", hevyId: pendingId(), title: CLAUDE_FOLDER, request: { routine_folder: { title: CLAUDE_FOLDER } } });
  try {
    const { raw } = await writer.createRoutineFolder(CLAUDE_FOLDER);
    const r = raw as { id?: unknown; routine_folder?: { id?: unknown } } | null;
    let id = Number(r?.id ?? r?.routine_folder?.id);
    if (!Number.isFinite(id)) id = (await writer.listRoutineFolders()).find((f) => f.title === CLAUDE_FOLDER)?.id ?? NaN;
    if (!Number.isFinite(id)) throw new ToolError(`Created the "${CLAUDE_FOLDER}" folder but couldn't read its id. Nothing was sent for the routine; try again.`);
    await closeAudit(sql, auditId, "ok", { hevyId: String(id), response: raw });
    return remember(id);
  } catch (err) {
    await closeAudit(sql, auditId, err instanceof HevyWriteError && err.unconfirmed ? "unconfirmed" : "rejected", { response: { error: (err as Error).message } });
    throw err; // a retry re-lists folders first, so an unconfirmed creation heals itself
  }
}

function extractRoutineId(raw: unknown): string | null {
  const r = (raw as { routine?: unknown } | null)?.routine ?? raw;
  const first = Array.isArray(r) ? r[0] : r;
  const id = (first as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

// ---- tools ------------------------------------------------------------------

export async function createRoutine(ctx: ToolCtx, writer: HevyWriteApi, input: RoutineInput, opts: { dry_run?: boolean } = {}) {
  const prepared = await prepareRoutine(ctx, input);
  const title = prepared.body.title;

  if (opts.dry_run) {
    return { dry_run: true, message: "Preview only: nothing was sent to Hevy. Show this to the user and get a yes before calling again without dry_run.", units: ctx.units, routine: prepared.preview, warnings: prepared.warnings };
  }

  const reservation = await reserveWrite<{ hevyId: string; outcome: string; mins: number }>(ctx.sql, {
    lockKey: "hevy_write:routine:" + title,
    kind: "routine",
    title,
    request: prepared.body,
    // same title created in the last 10 minutes (pending / ok / unconfirmed) = already done
    findDuplicate: async (tx) => {
      const [dup] = await tx<{ hevy_id: string; outcome: string; mins: string }[]>`
        select hevy_id, outcome, round(extract(epoch from (now() - created_at)) / 60)::text as mins
        from hevy_writes
        where kind = 'routine' and action = 'create' and title = ${title}
          and outcome in ('pending', 'ok', 'unconfirmed')
          and created_at > now() - ${GUARD_MINUTES} * interval '1 minute'
        order by created_at desc limit 1`;
      return dup ? { hevyId: dup.hevy_id, outcome: dup.outcome, mins: Number(dup.mins) } : null;
    },
  });
  if (reservation.existing) {
    const { hevyId, outcome, mins } = reservation.existing;
    return {
      already_created: true,
      ...(outcome === "ok" ? { routine_id: hevyId } : {}),
      message: outcome === "ok"
        ? `A routine called "${title}" was created ${mins} minute(s) ago, so I did not create a duplicate. Use update_routine with routine_id to change it, or pick a different title.`
        : `An attempt to create "${title}" was made ${mins} minute(s) ago and its result is unconfirmed. Check the "${CLAUDE_FOLDER}" folder in Hevy before trying again.`,
    };
  }
  const { auditId } = reservation;

  let folderId: number;
  try {
    folderId = await ensureClaudeFolder(ctx.sql, writer);
  } catch (err) {
    await closeAudit(ctx.sql, auditId, "rejected", { response: { error: (err as Error).message } });
    if (err instanceof ToolError) throw err;
    throw new ToolError(`Couldn't prepare the "${CLAUDE_FOLDER}" folder in Hevy: ${(err as Error).message} The routine was not created.`);
  }

  const request: RoutineBody = { ...prepared.body, folder_id: folderId };
  await ctx.sql`update hevy_writes set request = ${ctx.sql.json(request as never)} where id = ${auditId}`;

  const { raw } = await attempt(ctx.sql, auditId, { what: "create", thing: "routine", whereToLook: `the "${CLAUDE_FOLDER}" folder in Hevy` }, () => writer.createRoutine(request));
  const id = extractRoutineId(raw);
  const warnings = [...prepared.warnings];
  if (!id) warnings.push("Hevy created the routine but its reply had no id; it is in the Claude folder but cannot be updated through me.");
  const auditWarning = await closeAudit(ctx.sql, auditId, "ok", { hevyId: id ?? `unknown:${randomUUID()}`, response: raw });
  if (auditWarning) warnings.push(auditWarning);

  return {
    created: true,
    routine_id: id,
    folder: CLAUDE_FOLDER,
    message: `Created in Hevy under the "${CLAUDE_FOLDER}" folder. To remove it, delete it in the Hevy app (the API can't delete).`,
    units: ctx.units,
    routine: prepared.preview,
    warnings,
  };
}

export async function updateRoutine(ctx: ToolCtx, writer: HevyWriteApi, input: RoutineInput & { routine_id: string }, opts: { dry_run?: boolean } = {}) {
  const [mine] = await ctx.sql<{ hevy_id: string }[]>`
    select hevy_id from hevy_writes where kind = 'routine' and action = 'create' and outcome = 'ok' and hevy_id = ${input.routine_id} limit 1`;
  if (!mine) throw new ToolError(`I can only update routines I created myself. "${input.routine_id}" isn't one of them (your hand-made routines are never touched). Use the routine_id returned by create_routine.`);

  const prepared = await prepareRoutine(ctx, input);
  if (opts.dry_run) {
    return { dry_run: true, message: "Preview only: nothing was sent to Hevy. This would REPLACE the whole routine.", units: ctx.units, routine: prepared.preview, warnings: prepared.warnings };
  }

  let folderId: number;
  let previous: unknown;
  try {
    folderId = await ensureClaudeFolder(ctx.sql, writer);
    previous = await writer.getRoutine(input.routine_id); // keep the old version: an overwrite has no undo
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`Couldn't read the current routine, so I did not overwrite it: ${(err as Error).message}`);
  }

  const request: RoutineBody = { ...prepared.body, folder_id: folderId };
  const auditId = await openAudit(ctx.sql, { kind: "routine", action: "update", hevyId: input.routine_id, title: prepared.body.title, request, previous });
  const { raw } = await attempt(ctx.sql, auditId, { what: "update", thing: "routine", whereToLook: `the "${CLAUDE_FOLDER}" folder in Hevy` }, () => writer.updateRoutine(input.routine_id, request));
  const warnings = [...prepared.warnings];
  const auditWarning = await closeAudit(ctx.sql, auditId, "ok", { response: raw });
  if (auditWarning) warnings.push(auditWarning);

  return { updated: true, routine_id: input.routine_id, folder: CLAUDE_FOLDER, message: "The routine in Hevy was replaced. The previous version is saved in the audit log.", units: ctx.units, routine: prepared.preview, warnings };
}
