import type { ClassInput } from "./types";

const TYPES = ["strength", "strength_hiit", "cardio_endurance", "mixed"];
const FORMATS = ["sets", "every_n_minutes", "emom", "amrap", "for_time", "intervals", "other"];
const PRECISIONS = ["exact", "partial", "estimated"];
const SET_TYPES = ["warmup", "normal", "failure", "dropset"];
const isInt = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
const okDistance = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 100_000;
const okCalories = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 5000;

// Everything wrong with a class submission, all at once (a model can fix them in one round trip). Pure.
export function validateClassInput(i: ClassInput): string[] {
  const p: string[] = [];
  if (!i.gym?.trim()) p.push("gym is required (e.g. 'My Gym').");
  if (!TYPES.includes(i.class_type)) p.push(`class_type must be one of ${TYPES.join(", ")}.`);
  if (!i.board_text?.trim()) p.push("board_text is required: transcribe the whole board.");
  if (!PRECISIONS.includes(i.precision)) p.push(`precision must be one of ${PRECISIONS.join(", ")}.`);
  if (i.completion_pct !== undefined && !(typeof i.completion_pct === "number" && i.completion_pct >= 0 && i.completion_pct <= 100)) p.push("completion_pct must be between 0 and 100.");
  if (i.coaching_note !== undefined && (typeof i.coaching_note !== "string" || i.coaching_note.length > 1500)) p.push("coaching_note must be text of at most 1,500 characters (it becomes the Hevy description). Shorten it and call again.");
  if (i.duration_min !== undefined && !isInt(i.duration_min, 5, 300)) p.push("duration_min must be a whole number of minutes (5 to 300).");
  if (!Array.isArray(i.blocks) || i.blocks.length === 0) { p.push("at least one block is required."); return p; }

  i.blocks.forEach((b, bi) => {
    const bl = `block ${b.label || bi + 1}`;
    if (!b.label?.trim()) p.push(`block ${bi + 1}: label is required (A, B, ...).`);
    if (!FORMATS.includes(b.format)) p.push(`${bl}: format must be one of ${FORMATS.join(", ")}.`);
    if (b.sets_done !== undefined && !isInt(b.sets_done, 0, 20)) p.push(`${bl}: sets_done must be a whole number (0 to 20).`);
    if (b.sets && (!isInt(b.sets.min, 1, 20) || !isInt(b.sets.max, 1, 20) || b.sets.min > b.sets.max)) p.push(`${bl}: sets needs whole numbers with min <= max.`);
    if (b.rounds !== undefined && !isInt(b.rounds, 1, 50)) p.push(`${bl}: rounds must be a whole number.`);
    if (b.finish_s !== undefined && !isInt(b.finish_s, 1, 86_400)) p.push(`${bl}: finish_s must be whole seconds.`);
    if (!Array.isArray(b.movements) || b.movements.length === 0) { p.push(`${bl}: at least one movement is required.`); return; }
    b.movements.forEach((m, mi) => {
      const ml = `${bl}, movement ${mi + 1} (${m.movement || "unnamed"})`;
      if (!m.movement?.trim()) p.push(`${ml}: movement name is required.`);
      if (!m.target || typeof m.target !== "object") p.push(`${ml}: target (the board's prescription) is required.`);
      if (m.target?.distance_m !== undefined && !okDistance(m.target.distance_m)) p.push(`${ml}: target.distance_m must be meters between 1 and 100000.`);
      if (m.target?.calories !== undefined && !okCalories(m.target.calories)) p.push(`${ml}: target.calories must be a number between 1 and 5000.`);
      if (m.target?.share !== undefined && !(typeof m.target.share === "number" && m.target.share > 0 && m.target.share <= 1)) p.push(`${ml}: target.share must be above 0 and at most 1 (0.5 = half, split with a partner).`);
      for (const k of ["total", "optional"] as const) if (m.target?.[k] !== undefined && typeof m.target[k] !== "boolean") p.push(`${ml}: target.${k} must be true or false.`);
      for (const [j, s] of (m.done_sets ?? []).entries()) {
        const sl = `${ml}, set ${j + 1}`;
        if (s.reps !== undefined && !isInt(s.reps, 1, 500)) p.push(`${sl}: reps must be a whole number (1 to 500).`);
        if (s.duration_s !== undefined && !isInt(s.duration_s, 1, 86_400)) p.push(`${sl}: duration_s must be whole seconds.`);
        if (s.distance_m !== undefined && !okDistance(s.distance_m)) p.push(`${sl}: distance_m must be meters between 1 and 100000.`);
        if (s.calories !== undefined && !okCalories(s.calories)) p.push(`${sl}: calories must be a number between 1 and 5000.`);
        if (s.weight !== undefined && !(typeof s.weight === "number" && Number.isFinite(s.weight) && s.weight >= 0 && s.weight <= 1500)) p.push(`${sl}: weight must be between 0 and 1500.`);
        if (s.type !== undefined && !SET_TYPES.includes(s.type)) p.push(`${sl}: type must be one of ${SET_TYPES.join(", ")}.`);
        if (s.reps === undefined && s.duration_s === undefined && s.distance_m === undefined) p.push(`${sl}: needs reps, duration_s or distance_m.`);
      }
      const ws = m.weight === undefined ? [] : Array.isArray(m.weight) ? m.weight : [m.weight];
      if (ws.some((w) => !(typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1500))) p.push(`${ml}: weight must be between 0 and 1500.`);
    });
  });
  return p;
}
