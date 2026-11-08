import type { Sql } from "../db";
import { normalize, rankExercises } from "../match";
import type { CustomExerciseBody } from "../hevy/write";
import { loadTemplates } from "../tools/exercises";
import type { MovementInput } from "./types";

// Board movement -> Hevy exercise TITLE. Barbell and dumbbell lifts must land on the same standard
// Hevy's built-in exercises for common board movements, so class and gym progress merge in get_exercise_progress.
// Edit this list to match the movements and machines YOUR gym posts; a movement that isn't here falls back to a search of
// the Hevy exercise library, and is reported (never silently created) when nothing fits.
export const MOVEMENT_ALIASES: Record<string, string> = {
  // Cardio machines (a plain "bike" once fell to fuzzy matching and became Air Bike; here a studio bike is Cycling).
  // All three are DISTANCE exercises in Hevy: give distance_m.
  bike: "Cycling", "stationary bike": "Cycling", "spin bike": "Cycling", cycling: "Cycling", cycle: "Cycling",
  "air bike": "Air Bike", "assault bike": "Air Bike", "echo bike": "Air Bike", "fan bike": "Air Bike",
  ski: "Ski Erg", "ski erg": "Ski Erg", skierg: "Ski Erg",
  row: "Rowing Machine", rower: "Rowing Machine", rowing: "Rowing Machine", "rowing machine": "Rowing Machine",
  "barbell strict press": "Overhead Press (Barbell)",
  "strict press": "Overhead Press (Barbell)",
  "overhead press": "Overhead Press (Barbell)",
  // A class pull-up is the unassisted one (pass exercise_template_id for "Pull Up (Assisted)" when the assisted machine was used)
  "pull up": "Pull Up",
  "pull ups": "Pull Up",
  "dumbbell bicep curl": "Bicep Curl (Dumbbell)",
  "bicep curl": "Bicep Curl (Dumbbell)",
  "barbell bench press": "Bench Press (Barbell)",
  "bench press": "Bench Press (Barbell)",
  "barbell pendlay row": "Pendlay Row (Barbell)",
  "barbell pendley row": "Pendlay Row (Barbell)", // the board's typo
  "pendlay row": "Pendlay Row (Barbell)",
  "pendley row": "Pendlay Row (Barbell)",
  "cable crunch": "Cable Crunch",
  "cable weighted crunch": "Cable Crunch",
  "cable weighted crunches": "Cable Crunch",
  "dumbbell chest press": "Bench Press (Dumbbell)",
  "dumbbell 1 1 2 chest press": "Bench Press (Dumbbell)",
  "dumbbell single arm row": "Dumbbell Row",
  "dumbbell row": "Dumbbell Row",
  "dumbbell overhead tricep extension": "Triceps Extension (Dumbbell)",
  "dumbbell oh tricep extension": "Triceps Extension (Dumbbell)",
  "plank": "Plank",
  "plank hold": "Plank",
  "v up": "V Up",
  "v ups": "V Up",
  "sit up": "Sit Up",
  "sit ups": "Sit Up",
  "ab mat sit up": "Sit Up",
  "ab mat sit ups": "Sit Up",
};

export type Resolution =
  | { kind: "template"; id: string; title: string; type: string | null; via: "explicit" | "remembered" | "alias_map" | "fuzzy" | "existing_custom" }
  | { kind: "create"; body: CustomExerciseBody }
  | { kind: "unresolved"; message: string };

export const CUSTOM_TYPES = ["weight_reps", "reps_only", "bodyweight_reps", "bodyweight_assisted_reps", "duration", "weight_duration", "distance_duration", "short_distance_weight"];
export const MUSCLES = ["abdominals", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "calves", "glutes", "abductors", "adductors", "lats", "upper_back", "traps", "lower_back", "chest", "cardio", "neck", "full_body", "other"];
export const EQUIPMENT = ["none", "barbell", "dumbbell", "kettlebell", "machine", "plate", "resistance_band", "suspension", "other"];

// Loose ideas for the "nothing matched" message: titles sharing ANY meaningful word with the movement, most-used first.
const GENERIC = new Set(["dumbbell", "barbell", "cable", "machine", "bodyweight", "weighted", "single", "arm", "the", "and"]);
const stem = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
export function looseSuggestions<T extends { title: string; sessions: number }>(query: string, all: T[], limit = 4): T[] {
  const q = new Set(normalize(query).split(" ").map(stem).filter((t) => t && !GENERIC.has(t)));
  return all
    .map((t) => ({ t, hits: normalize(t.title).split(" ").map(stem).filter((w) => q.has(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.t.sessions - a.t.sessions || a.t.title.length - b.t.title.length)
    .slice(0, limit)
    .map((x) => x.t);
}

export const aliasKey = (movement: string) => `class_alias:${normalize(movement)}`;
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

type Row = { id: string; title: string; type: string | null };
const byId = async (sql: Sql, id: string) => (await sql<Row[]>`select id, title, type from exercise_templates where id = ${id}`)[0];
// Prefer Hevy's standard exercise over a custom one with the same name.
const byTitle = async (sql: Sql, title: string) => (await sql<Row[]>`select id, title, type from exercise_templates where lower(title) = lower(${title}) order by is_custom, id limit 1`)[0];

export async function resolveMovement(sql: Sql, m: MovementInput): Promise<Resolution> {
  const norm = normalize(m.movement);
  const tpl = (r: Row, via: Extract<Resolution, { kind: "template" }>["via"]): Resolution => ({ kind: "template", id: r.id, title: r.title, type: r.type, via });

  if (m.exercise_template_id) {
    const r = await byId(sql, m.exercise_template_id);
    return r ? tpl(r, "explicit") : { kind: "unresolved", message: `"${m.movement}": exercise_template_id "${m.exercise_template_id}" doesn't exist. Use search_exercises for a real id.` };
  }

  if (m.create_custom) {
    const c = m.create_custom;
    const title = (c.title ?? titleCase(m.movement)).trim();
    const existing = await byTitle(sql, title);
    if (existing) return tpl(existing, "existing_custom"); // never create what already exists
    const problems: string[] = [];
    if (!CUSTOM_TYPES.includes(c.exercise_type)) problems.push(`exercise_type must be one of ${CUSTOM_TYPES.join(", ")}`);
    if (!MUSCLES.includes(c.muscle_group)) problems.push(`muscle_group must be one of ${MUSCLES.join(", ")}`);
    if (c.equipment && !EQUIPMENT.includes(c.equipment)) problems.push(`equipment must be one of ${EQUIPMENT.join(", ")}`);
    if (problems.length) return { kind: "unresolved", message: `"${m.movement}": create_custom is invalid: ${problems.join("; ")}.` };
    return { kind: "create", body: { title, exercise_type: c.exercise_type, equipment_category: c.equipment ?? "none", muscle_group: c.muscle_group, other_muscles: c.other_muscles ?? [] } };
  }

  const [remembered] = await sql<{ value: string }[]>`select value from settings where key = ${aliasKey(m.movement)}`;
  if (remembered) {
    const r = await byId(sql, remembered.value);
    if (r) return tpl(r, "remembered");
  }

  const aliased = MOVEMENT_ALIASES[norm];
  if (aliased) {
    const r = await byTitle(sql, aliased);
    if (r) return tpl(r, "alias_map");
  }

  // Fuzzy, but only a near-exact title (score 700 = the title minus its "(Equipment)" suffix equals the movement).
  const all = await loadTemplates(sql);
  const ranked = rankExercises(m.movement, all);
  if (ranked[0] && ranked[0].score >= 700) {
    const r = ranked[0].item;
    return { kind: "template", id: r.id, title: r.title, type: r.type, via: "fuzzy" };
  }
  const near = (ranked.length ? ranked.slice(0, 4).map((r) => r.item) : looseSuggestions(m.movement, all)).map((t) => `${t.title} (${t.id})`);
  return {
    kind: "unresolved",
    message:
      `"${m.movement}": no matching Hevy exercise.` +
      (near.length ? ` Closest: ${near.join("; ")}.` : "") +
      ` Either pass exercise_template_id for one of those, or add create_custom: {exercise_type, muscle_group, equipment} to create a NEW exercise (permanent: Hevy can't edit or delete it).`,
  };
}

export async function rememberAlias(sql: Sql, movement: string, templateId: string): Promise<void> {
  await sql`insert into settings (key, value) values (${aliasKey(movement)}, ${templateId}) on conflict (key) do update set value = excluded.value`;
}
