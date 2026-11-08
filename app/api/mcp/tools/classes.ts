import { z } from "zod";
import { getHevyWriter } from "@/core/runtime";
import { getClassHistory } from "@/core/tools/classes";
import { logClassWorkout } from "@/core/classes/log";
import { CUSTOM_TYPES, EQUIPMENT, MUSCLES } from "@/core/classes/aliases";
import type { ClassInput } from "@/core/classes/types";
import { readTool, writeTool, READ, type Server } from "../shared";

const TARGET = z.object({
  reps: z.union([z.number().int(), z.object({ min: z.number().int(), max: z.number().int() })]).optional().describe("a number, or {min,max} for a range like 10-12"),
  reps_by_set: z.array(z.number().int()).optional().describe("'8-6-4-2' = [8,6,4,2]"),
  per_side: z.boolean().optional().describe("'8/ARM'"),
  complex: z.string().optional().describe("'1+1+2'"),
  complex_note: z.string().optional(),
  duration_s: z.number().int().optional().describe("a timed hold: '1 MIN' = 60"),
  distance_m: z.number().min(1).max(100000).optional().describe("cardio machines, in METERS: '200M SKI' = 200, '0.25 MI' = 402"),
  max: z.boolean().optional().describe("'MAX reps in the remaining time'"),
  total: z.boolean().optional().describe("true when the number is for the WHOLE block, not each round: a cash-out of '40 power cleans'"),
  share: z.number().gt(0).max(1).optional().describe("the user's part when the work is split with a partner: 0.5 for 'split with partner'"),
  optional: z.boolean().optional().describe("a 'pick 2 of 3' choice: left out of completion when nothing was done"),
  calories: z.number().min(1).max(5000).optional().describe("what the machine screen showed (the board's calorie target)"),
  note: z.string().optional(),
  alternatives: z.array(z.object({ label: z.string(), movement: z.string().optional(), text: z.string().optional() })).optional().describe("the RX version(s)"),
});
const DONE_SET = z.object({
  reps: z.number().int().min(1).max(500).optional(),
  weight: z.number().min(0).max(1500).optional().describe("user's units; for assisted pull-ups this is the assistance"),
  duration_s: z.number().int().min(1).max(86400).optional(),
  distance_m: z.number().min(1).max(100000).optional().describe("meters"),
  calories: z.number().min(1).max(5000).optional().describe("what the machine screen showed; Hevy still needs a distance or a time, so keep the estimated distance (assumed)"),
  type: z.enum(["warmup", "normal", "failure", "dropset"]).optional(),
});
const CLASS_MOVEMENT = z.object({
  movement: z.string().min(1).describe("normalised lowercase name, typos fixed: 'barbell pendlay row', 'dumbbell bicep curl', 'plank'"),
  exercise_template_id: z.string().optional().describe("pick a specific Hevy exercise (from search_exercises); beats automatic matching"),
  create_custom: z.object({
    exercise_type: z.enum(CUSTOM_TYPES as [string, ...string[]]),
    muscle_group: z.enum(MUSCLES as [string, ...string[]]),
    equipment: z.enum(EQUIPMENT as [string, ...string[]]).optional(),
    other_muscles: z.array(z.enum(MUSCLES as [string, ...string[]])).optional(),
    title: z.string().optional(),
  }).optional().describe("ONLY when no Hevy exercise fits and the user agreed: creates a NEW custom exercise that can never be edited or deleted"),
  target: TARGET.describe("what the board prescribed"),
  variant_done: z.string().nullable().optional().describe("null = as written; 'RX'; 'scaled'; or free text"),
  done_sets: z.array(DONE_SET).optional().describe("exactly what was done, set by set (omit to let the tool derive it conservatively)"),
  weight: z.union([z.number(), z.array(z.number())]).optional().describe("weight used: one number for all sets, or one per set"),
  assumed: z.boolean().optional(),
  note: z.string().optional(),
});
const CLASS_BLOCK = z.object({
  label: z.string().min(1),
  format: z.enum(["sets", "every_n_minutes", "emom", "amrap", "for_time", "intervals", "other"]),
  sets: z.object({ min: z.number().int(), max: z.number().int() }).optional().describe("'3-4 SETS'"),
  interval_s: z.number().int().optional(),
  rounds: z.number().int().optional().describe("the posted round count: REQUIRED whenever the board posts one, or the block's completion can't be counted"),
  time_cap_s: z.number().int().optional(),
  finish_s: z.number().int().min(1).max(86400).optional().describe("the time they finished a for_time block in, when they finished it"),
  sets_done: z.number().int().min(0).max(20).optional().describe("how many times the block was ACTUALLY done"),
  movements: z.array(CLASS_MOVEMENT).min(1),
});
const CLASS_FIELDS = {
  gym: z.string().min(1).describe("e.g. 'My Gym'"),
  class_type: z.enum(["strength", "strength_hiit", "cardio_endurance", "mixed"]),
  title: z.string().optional(),
  start_at: z.string().optional().describe("ONLY if the user states the start time (ISO with offset); beats everything"),
  duration_min: z.number().int().min(5).max(300).optional(),
  photo_time: z.string().optional().describe("when the board photo was taken (ISO with offset): used to find the class in Oura"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("local date, only if there is no time at all"),
  board_text: z.string().min(1).describe("your full transcription of ALL the board photos"),
  blocks: z.array(CLASS_BLOCK).min(1),
  completion_pct: z.number().min(0).max(100).optional().describe("only for an overall estimate like 'did about 75%'"),
  precision: z.enum(["exact", "partial", "estimated"]),
  user_notes: z.string().optional().describe("the voice note, as said"),
  log_to_hevy: z.boolean().optional().describe("default true"),
  coaching_note: z.string().max(1500).optional().describe("the coaching note you write from the dry run's `analysis` (see analysis.note_instructions): plain text, at most 1,500 characters. It becomes the Hevy workout description and is saved with the class. Omit it in the dry run; add it to the real call after the user approved it"),
  replaces_session_id: z.number().int().optional().describe("REDO a class: the session_id (from get_class_history) of the class this replaces. Only works after the user deleted its Hevy copy in the app and sync_now (source hevy) has run"),
  dry_run: z.boolean().optional().describe("true = preview only; nothing is sent or saved"),
};


export function register(server: Server) {
    server.registerTool(
      "log_class_workout",
      {
        title: "Log a class workout",
        description:
          "Log a finished instructor-led class (e.g. a gym's strength or conditioning class) from a photo of the board plus what the user says: saved in the hub (planned vs done) AND sent to Hevy as a finished workout, one superset per lettered block, with Oura heart rate attached. " +
          "WORKFLOW: (1) Read ALL board photos as ONE board and write it out as board_text; use a time/place shown in a photo as photo_time. (2) Include EVERY movement the board posted: one they skipped goes in with done_sets: [] (stored, counted as 0% of its posted work, not sent to Hevy), never left out. Apply the voice note, then ask ONE combined follow-up for what is still missing and matters (never a string of questions): weights for loaded lifts (the board never shows them), sets actually done when the board says '3-4 SETS', RX or scaled, and counts for MAX-rep movements. The user may answer 'skip': then use the conservative value, mark assumed, precision 'partial'. NEVER invent a weight or a count the user did not give. In that SAME one follow-up also ask, once per class and only for what the board makes relevant: times or calories for the cardio pieces (duration_s / calories on the set), which work was split with a partner (target.share, e.g. 0.5), and how many rounds were posted (block rounds; target.total for a whole-block number such as a cash-out). They never have to answer: anything missing is 'not counted', never a guess. " +
          "(3) If they only give an overall percentage ('did about 75%'), set completion_pct and precision 'estimated' and omit sets_done/done_sets (the tool scales the sets). (4) class_type: strength (mostly loaded lifts), strength_hiit, cardio_endurance or mixed. " +
          "(5) ALWAYS call with dry_run: true first. Show the user the block-by-block summary with weights, the time found, any assumptions, and any NEW custom exercises. The dry run also returns `analysis` (board completion vs last time, each exercise vs last time, highlights, trends) and `note_instructions`: write a short COACHING NOTE from `analysis` ONLY (never invent a comparison or a number; say 'estimated' where it says estimated; a 'not_compared' item is never worse), show it in the preview, then wait for a clear yes and call again without dry_run, passing the approved text as `coaching_note`. The note becomes the Hevy workout description (the sets are already in the workout, so it is not a station list) and is saved with the class; with no coaching_note a short summary of the numbers is used. Hevy has NO delete through the API: a logged workout or a custom exercise can only be removed by the user in the app. " +
          "NOTATION: 'A, B, C' = separate blocks done in order, movements inside a block are a circuit; '3-4 SETS' = sets {min:3,max:4}; 'X 8-6-4-2' = reps_by_set [8,6,4,2] (with 3 sets done it is 8-6-4); 'X 10-12' = reps {min,max}; '8/ARM' = reps 8, per_side (the target is per side, but done_sets reps are BOTH sides combined: 3 sets of 8/ARM = done_sets of 16, 16, 16; the tool does the same when it derives them); '1+1+2 ... X 4' = complex '1+1+2', reps 4; '1 MIN' = duration_s 60; 'EVERY 3 MINUTES X 3 ROUNDS' = format every_n_minutes, interval_s 180, rounds 3; 'MAX ... IN REMAINING TIME' = max true; '(RX - ...)' = alternatives; fix board typos (PENDLEY = pendlay); '200M SKI' / '400M BIKE' / '250M ROW' = distance_m in METERS (never reps). A plain 'BIKE' is movement 'bike' (Hevy's Cycling); write 'air bike' only if the board says air, assault or echo bike. " +
          "MOVEMENTS are matched to the same Hevy exercises used in the gym, so class and gym progress merge. If one matches nothing, the tool says so and lists options: choose with exercise_template_id (use search_exercises) or, only with the user's agreement, add create_custom. Weights are in the user's units (pounds by default; for assisted pull-ups the weight is the assistance). A class within 2 hours of an already-logged one is not logged twice. TO REDO a logged class (wrong exercise, wrong numbers): the user deletes its workout in the Hevy app, you call sync_now with source hevy, then call this again with replaces_session_id (from get_class_history) and dry_run first; the hub refuses while the old Hevy copy still exists. The dry run runs the same duplicate check: if it returns would_be_refused, tell the user why instead of asking for a yes.",
        inputSchema: z.object(CLASS_FIELDS),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ dry_run, ...input }) => writeTool((ctx) => logClassWorkout(ctx, getHevyWriter(), input as ClassInput, { dry_run })),
    );

    server.registerTool(
      "get_class_history",
      {
        title: "Class history",
        description:
          "Past instructor-led classes the user logged: date, type, completion %, Oura heart rate, and per block and movement what the board prescribed versus what was done (weights in the user's units). Pass `movement` (e.g. 'v up', 'plank', 'pendlay row') to see that movement's trend across classes, or `class_type` to filter. Defaults to the last 90 days. Barbell and dumbbell class lifts also appear in get_exercise_progress, because they map to the same Hevy exercises as the gym lifts.",
        inputSchema: z.object({ movement: z.string().optional(), class_type: z.enum(["strength", "strength_hiit", "cardio_endurance", "mixed"]).optional(), days: z.number().int().min(1).max(366).optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_class_history", (ctx) => getClassHistory(ctx, input)),
    );

    // Prompts show up in Claude's prompt picker and just start the right conversation (DESIGN Phase 9). They run no tools themselves.
    server.registerPrompt(
      "log_class",
      {
        title: "Log a class",
        description: "Log a finished instructor-led class from a photo of the board plus a voice note.",
        argsSchema: { notes: z.string().optional().describe("What you did, weights, anything skipped") },
      },
      ({ notes }) => ({
        messages: [{ role: "user", content: { type: "text", text:
          "Log the class I just did. I'm attaching photos of the board" + (notes ? ` and here is what I did: ${notes}` : " and I'll tell you what I did") + ". " +
          "Read every photo as ONE board, apply what I said, ask me ONE combined follow-up for anything missing that matters (weights for loaded lifts, sets actually done, counts for max-rep movements), then call log_class_workout with dry_run true, show me the summary and wait for my yes. Never invent a weight I didn't give." } }],
      }),
    );
}
