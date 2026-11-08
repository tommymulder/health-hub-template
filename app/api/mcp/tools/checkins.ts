import { z } from "zod";
import { logCheckin } from "@/core/checkins/log";
import { getCheckins, getFeelVsRing } from "@/core/checkins/read";
import { DATE, readTool, writeTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "log_checkin",
      {
        title: "Log how the morning felt",
        description:
          "Save how the user felt when they woke up, on a 1 to 5 scale. Hub only, no Hevy. Logging again the same day replaces the rating. " +
          "Ask \"How did you feel when you woke up? (1 Awful, 2 Rough, 3 OK, 4 Good, 5 Great)\" and do not show the Oura sleep score before the rating is given. " +
          "date defaults to today (in the hub's timezone). A past date, at most 2 days back, is stored as recalled. A note is optional and at most 500 characters. If a rating already existed for that day, the reply has `replaced`: tell the user which rating was replaced.",
        inputSchema: z.object({
          rating: z.number().int().min(1).max(5).describe("1 Awful, 2 Rough, 3 OK, 4 Good, 5 Great"),
          note: z.string().max(500).optional(),
          date: DATE.optional().describe("YYYY-MM-DD, default today, at most 2 days back"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => writeTool((ctx) => logCheckin(ctx, input)),
    );

    server.registerTool(
      "get_checkins",
      {
        title: "Morning check-ins",
        description:
          "How the user rated their mornings, newest first, with checked_in_today at the top. Each rating is paired only with that date's longest long_sleep (naps are ignored): sleep score, total/deep/REM, efficiency, latency, bedtime and wake time, average HRV, lowest heart rate, temperature deviation, that day's readiness, and the previous day's classes, lifting, steps and Oura tags. hours_after_waking is when they logged it minus the wake time. recalled means they logged a past morning. Defaults to 30 days. Call this before showing sleep data, and if checked_in_today is false, ask how they felt when they woke up first.",
        inputSchema: z.object({ days: z.number().int().min(1).max(366).optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_checkins", (ctx) => getCheckins(ctx, input), { oura: true }),
    );

    server.registerTool(
      "get_feel_vs_ring",
      {
        title: "Feel versus the ring",
        description:
          "How the morning ratings line up with the ring: good mornings (4-5) versus rough ones (1-2), each metric ranked by tie-aware Spearman correlation, and mismatch days (a high sleep score with a 1-2 rating, or a low score with a 4-5, using their own score quartiles). Rating 3 is neither good nor rough. Always returns both all ratings and those logged within 2 hours of waking. Under 14 rated mornings the answer says too early. From 14 to 29 it says early pattern, not proven. Never claim the ring caused the feeling, or that a sleep score is wrong because the rating disagrees. Defaults to 90 days. on_time_only leads with the within-2-hour ratings; both blocks are still returned.",
        inputSchema: z.object({
          days: z.number().int().min(1).max(366).optional(),
          on_time_only: z.boolean().optional().describe("Lead with ratings logged within 2 hours of waking. Both slices are still returned."),
        }),
        annotations: READ,
      },
      async (input) => readTool("get_feel_vs_ring", (ctx) => getFeelVsRing(ctx, input), { oura: true }),
    );
}
