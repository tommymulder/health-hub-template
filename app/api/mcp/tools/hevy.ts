import { z } from "zod";
import { getHevyWriter } from "@/core/runtime";
import { searchExercises } from "@/core/tools/exercises";
import { getExerciseProgress } from "@/core/tools/progress";
import { createRoutine, updateRoutine } from "@/core/tools/routines";
import { getTrainingSummary } from "@/core/tools/summary";
import { getRecentWorkouts, getWorkoutDetails } from "@/core/tools/workouts";
import { DATE, readTool, writeTool, READ, type Server } from "../shared";

const SET = z.object({
  type: z.enum(["warmup", "normal", "failure", "dropset"]).optional().describe("Defaults to normal."),
  weight: z.number().min(0).optional().describe("In the user's units (see `units` in other tools; pounds by default). Omit for bodyweight."),
  reps: z.number().int().min(1).max(200).optional(),
  duration_s: z.number().int().min(1).max(86400).optional().describe("For timed exercises such as a plank."),
});
const EXERCISE = z.object({
  exercise_template_id: z.string().min(1).describe("A real id from search_exercises. Never invent one."),
  rest_seconds: z.number().int().min(0).max(600).optional(),
  notes: z.string().max(500).optional(),
  sets: z.array(SET).min(1).max(20),
});

const ROUTINE_FIELDS = {
  title: z.string().min(1).max(100),
  notes: z.string().max(2000).optional(),
  exercises: z.array(EXERCISE).min(1).max(30),
  dry_run: z.boolean().optional().describe("true = validate and preview only; nothing is sent to Hevy."),
};


export function register(server: Server) {
    server.registerTool(
      "get_recent_workouts",
      {
        title: "Recent workouts",
        description:
          "List the user's recent lifting workouts from Hevy: date, time, title, duration, exercise names, working sets and total volume. Use for 'what have I been doing lately', for finding a workout id, or before planning a session. Defaults to the last 14 days; pass `days` or `start`/`end` (local dates). Weights are in the user's units (see `units`). Data is refreshed automatically if it is more than 3 hours old.",
        inputSchema: z.object({ days: z.number().int().min(1).max(366).optional(), start: DATE.optional(), end: DATE.optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_recent_workouts", (ctx) => getRecentWorkouts(ctx, input)),
    );

    server.registerTool(
      "get_workout_details",
      {
        title: "Workout details",
        description:
          "Full detail of one workout: every exercise and set (weight, reps, RPE, type), plus per-exercise top set, best estimated 1RM and volume. Pass a workout id from get_recent_workouts, or \"latest\" (the default) for the most recent workout. Includes Oura context when connected: heart rate during the workout (average, max, minutes per zone), the overlapping Oura workout, the night before (sleep score, hours, HRV) and that day's readiness. Use for 'how did that session go' and 'how did I sleep before it'. Note: history imported from another app may have no warm-up labels, so warm-up sets may be counted as working sets in `working_sets` and volume.",
        inputSchema: z.object({ workout_id: z.string().optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_workout_details", (ctx) => getWorkoutDetails(ctx, input), { oura: true }),
    );

    server.registerTool(
      "get_exercise_progress",
      {
        title: "Exercise progress",
        description:
          "Progress on one exercise over time: per session the top (heaviest) set, best estimated 1RM (Epley) with `best_e1rm_from` (the set that produced it, often NOT the top set: quote that set, not the top set), volume and whether it was an all-time PR, plus the overall trend. `exercise` can be a loose name ('bench', 'rdl', 'Squat (Barbell)') or a template id; it picks the version you have done most. Defaults to the last 180 days; pass `since` (YYYY-MM-DD) for longer. Use for 'how has my bench progressed'.",
        inputSchema: z.object({ exercise: z.string().min(1), since: DATE.optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_exercise_progress", (ctx) => getExerciseProgress(ctx, input)),
    );

    server.registerTool(
      "get_training_summary",
      {
        title: "Training summary",
        description:
          "Weekly training overview for a period (default last 4 weeks): sessions, volume, and hard sets per muscle group (primary muscle = 1 per set, secondary = 0.5), the most and least trained muscles, and days since each of the five main barbell lifts. Includes instructor-led classes: logged ones (counted once, by kind, with their sets) plus classes Oura detected that were never logged (count and minutes only). Use for 'what am I neglecting', 'how much am I training' and for planning a balanced session. For recovery and fitness trends alongside load use get_trends.",
        inputSchema: z.object({ start: DATE.optional(), end: DATE.optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_training_summary", (ctx) => getTrainingSummary(ctx, input), { oura: true }),
    );

    server.registerTool(
      "search_exercises",
      {
        title: "Search exercises",
        description:
          "Search Hevy's exercise library by name. Exercises the user has done are listed first, with how often and their last top set (weight × reps). REQUIRED before building a routine, so you use real exercise ids and sensible starting weights.",
        inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() }),
        annotations: READ,
      },
      async (input) => readTool("search_exercises", (ctx) => searchExercises(ctx, input)),
    );

    server.registerTool(
      "create_routine",
      {
        title: "Create Hevy routine",
        description:
          "Create a new workout routine in the user's Hevy app, inside a folder called 'Claude'. ONLY call this after the user has explicitly confirmed the exact workout in this conversation (exercises, sets, reps, weights). Hevy has NO delete through the API: a mistaken routine can only be removed by the user in the app, so show the plan first (or call with dry_run: true to preview) and wait for a clear yes. Always call search_exercises first so every exercise_template_id is real and the weights are sensible starting points. Weights are in the user's units. If the same title was created in the last 10 minutes this returns that routine instead of creating a duplicate.",
        inputSchema: z.object(ROUTINE_FIELDS),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ dry_run, ...input }) => writeTool((ctx) => createRoutine(ctx, getHevyWriter(), input, { dry_run })),
    );

    server.registerTool(
      "update_routine",
      {
        title: "Update Hevy routine",
        description:
          "Replace the entire contents of a routine that create_routine made earlier (pass its routine_id). It can only change routines this hub created, never the user's hand-made ones. This overwrites everything (title, notes, all exercises and sets), so send the complete new routine. Same rule as create_routine: only after the user has confirmed the change. The previous version is saved in the hub's audit log. Use dry_run: true to preview.",
        inputSchema: z.object({ routine_id: z.string().min(1), ...ROUTINE_FIELDS }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ dry_run, ...input }) => writeTool((ctx) => updateRoutine(ctx, getHevyWriter(), input, { dry_run })),
    );

    // Prompts show up in Claude's prompt picker and just start the right conversation (DESIGN Phase 9). They run no tools themselves.
    server.registerPrompt(
      "plan_workout",
      {
        title: "Plan a workout",
        description: "Plan today's session from recovery, recent training and the user's goals, then send it to Hevy after a clear yes.",
        argsSchema: { minutes: z.string().optional().describe("How long you have, e.g. 30"), focus: z.string().optional().describe("e.g. heavy lower, upper, easy day") },
      },
      ({ minutes, focus }) => ({
        messages: [{ role: "user", content: { type: "text", text:
          `Plan my workout${minutes ? ` (${minutes} minutes)` : ""}${focus ? `, focus: ${focus}` : ""}. ` +
          "First check how recovered I am (get_recovery for the last 7 days and get_trends for the direction over the last 8 weeks), what I've trained recently (get_training_summary) and my progress on the relevant lifts (get_exercise_progress). " +
          "Then propose the session in plain text with sets, reps and weights, say why it fits today's recovery and training load, and WAIT for my yes. After a yes: search_exercises, preview with create_routine dry_run, then create it." } }],
      }),
    );
}
