import { z } from "zod";
import { getOuraRuntime, getSyncDeps } from "@/core/runtime";
import { getHeartRate } from "@/core/tools/heartRate";
import { getTrends } from "@/core/tools/trends";
import { getSyncStatus, syncNow } from "@/core/tools/sync";
import { ping } from "@/core/tools/ping";
import { json, readTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "ping",
      {
        title: "Ping",
        description:
          "Health check for the Health Hub. Returns { ok, time } (UTC). Use to confirm the hub is reachable.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [{ type: "text", text: JSON.stringify(ping()) }],
      }),
    );

    server.registerTool(
      "get_sync_status",
      {
        title: "Sync status",
        description:
          "Per-source freshness: last successful sync, last error, how many workouts and exercise templates are stored, and whether the history backfill is complete. Use to explain why data might be missing or old.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => json(await getSyncStatus(getSyncDeps().sql)),
    );

    server.registerTool(
      "sync_now",
      {
        title: "Sync now",
        description:
          "Force a sync into the hub's database: Hevy workouts and exercise templates (then compares the stored workout count with Hevy's own) and, when connected, Oura sleep, readiness, activity, workouts and heart rate. Use `source` to sync just one. Use when the user says they just finished a workout, or when data looks stale. The first runs also continue the one-time history download (it resumes where it stopped; call again until `complete` is true). Apple Health cannot be pulled by the server (the phone pushes it); source 'apple' only re-processes deliveries already received, e.g. after a parser fix.",
        inputSchema: z.object({ source: z.enum(["hevy", "oura", "apple", "all"]).optional(), reprocess_all: z.boolean().optional().describe("apple only: re-parse every stored Apple Health delivery (after a parser fix), not just the unprocessed ones") }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ source, reprocess_all }) => json(await syncNow(getSyncDeps(), getOuraRuntime()?.deps ?? null, source ?? "all", { reprocess_all })),
    );

    server.registerTool(
      "get_trends",
      {
        title: "Weekly fitness trends",
        description:
          "The big picture over weeks, one row per Monday-start week: HRV (RMSSD), lowest heart rate (resting-heart-rate proxy), sleep hours and score, readiness, steps, vascular age, scale weight and body fat, and training load (instructor-led classes, Hevy lifting sessions, other cardio minutes, and workout_minutes_by_zone: minutes in each heart-rate zone inside ANY Oura workout, walks included, so Zone 2 minutes for the week are workout_minutes_by_zone.z2 with no better/worse verdict). Also compares the last 4 full weeks with the 4 before (with a better/worse verdict where one is clear), and gives a `recovery_signal`: last 7 nights of HRV and lowest heart rate against the user's own 60-night median, saying whether the two move TOGETHER (their rule: act only when they do): both_worse (the only one to act on), both_better, mixed (only one moved, or opposite ways), steady (neither moved) or not_enough_data. Report its plain-language `summary` to the user, never the code name. Use for 'am I getting fitter / leaner / more recovered?', 'is my HRV or resting heart rate improving?', 'how is my training load changing?', and before planning a block of training. Defaults to 12 weeks (up to 52). For one day's detail use get_recovery; for individual weigh-ins use get_body_metrics.",
        inputSchema: z.object({ weeks: z.number().int().min(4).max(52).optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_trends", (ctx) => getTrends(ctx, input), { oura: true }),
    );

    server.registerTool(
      "get_heart_rate",
      {
        title: "Heart rate for any time window",
        description:
          "Heart rate for ANY time window, for pairing with anything else that has a time: a workout from any source, a sleep, the hours before a check-in, a stressful day, the weeks around a lab draw. Get the window from the other tool first (workouts and sleeps carry start and end times). Returns average, min, max, samples, covered minutes and minutes in each of the user's Oura heart-rate zones (HR_ZONES; zone 2 is the second), for the whole window or grouped by hour (windows of 3 days or less), day or week (Monday start). Overnight readings are every 5 minutes; workouts every few seconds; the rest of the day is sparse, so check covered_minutes before trusting an average. A gap in coverage means the ring was off or not synced, never a low heart rate. part: all (default), awake (outside sleep) or asleep (overnight only). Window up to 92 days. Dates (2026-10-17) or date-times (2026-10-17T22:00) are in the hub timezone unless they carry an offset; a date-only end means the end of that day.",
        inputSchema: z.object({
          start: z.string().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM (in the hub's timezone unless it has an offset)"),
          end: z.string().describe("YYYY-MM-DD (means the end of that day) or YYYY-MM-DDTHH:MM"),
          group_by: z.enum(["none", "hour", "day", "week"]).optional(),
          part: z.enum(["all", "awake", "asleep"]).optional(),
        }),
        annotations: READ,
      },
      async (input) => readTool("get_heart_rate", (ctx) => getHeartRate(ctx, input), { oura: true }),
    );

    // Prompts show up in Claude's prompt picker and just start the right conversation (DESIGN Phase 9). They run no tools themselves.
    server.registerPrompt(
      "weekly_review",
      {
        title: "Weekly review",
        description: "How training, recovery and body composition are trending, and what to change.",
        argsSchema: { weeks: z.string().optional().describe("How many weeks to look back, default 8") },
      },
      ({ weeks }) => ({
        messages: [{ role: "user", content: { type: "text", text:
          `Give me a weekly review over the last ${weeks || "8"} weeks. Use get_trends first, then get_body_metrics if it adds something. ` +
          "Lead with the answer: am I getting fitter, leaner and more recovered? Cover HRV and resting heart rate, training load against my targets, and weight and body fat (read averages, not single weigh-ins). Name the one or two things to change next week. Say how confident you are in each claim." } }],
      }),
    );
}
