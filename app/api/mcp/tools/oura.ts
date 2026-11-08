import { z } from "zod";
import { COLLECTION_NAMES } from "@/core/oura/collections";
import { startOuraConnect } from "@/core/oura/connect";
import { getOuraRuntime, getToolCtx } from "@/core/runtime";
import { getOuraData, getRecovery } from "@/core/tools/recovery";
import { json, DATE, readTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "get_recovery",
      {
        title: "Recovery overview",
        description:
          "Daily recovery picture from the user's Oura Ring: readiness score and contributors, sleep (score, hours, efficiency, deep/REM, bedtime and wake time, naps), average HRV (RMSSD), lowest heart rate, temperature deviation, steps, stress and resilience. Each key number also shows its % difference from the user's own baseline: the MEDIAN of their previous 60 days (their rule; steadier than an average). Use before designing a workout ('how recovered am I?') and for sleep or HRV questions about specific days. For a multi-week view (is HRV or resting heart rate improving?) use get_trends. Defaults to the last 14 days; pass `days` (up to 366). Also returns morning_checkin: today's 1-5 wake-up rating, or null if they haven't rated yet (then ask before showing sleep numbers, and log it with log_checkin).",
        inputSchema: z.object({ days: z.number().int().min(1).max(366).optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_recovery", (ctx) => getRecovery(ctx, input), { oura: true }),
    );

    server.registerTool(
      "get_oura_data",
      {
        title: "Raw Oura documents",
        description:
          "Escape hatch: the raw stored Oura documents for one collection and date range (e.g. daily_spo2, daily_stress, vO2_max, daily_cardiovascular_age, workout, session, enhanced_tag, rest_mode_period, sleep_time, or any other). Use only when get_recovery doesn't cover the question. Large time series are summarised unless include_series is true. Newest first, capped at 40 documents.",
        inputSchema: z.object({
          collection: z.enum(COLLECTION_NAMES as [string, ...string[]]),
          start: DATE.optional(),
          end: DATE.optional(),
          include_series: z.boolean().optional(),
        }),
        annotations: READ,
      },
      async (input) => readTool("get_oura_data", (ctx) => getOuraData(ctx, input), { oura: true }),
    );

    server.registerTool(
      "connect_oura",
      {
        title: "Connect Oura",
        description:
          "One-time setup: returns a link for the user to open and approve Oura access (sleep, readiness, heart rate, workouts). The link works once and expires in 10 minutes; after approving, Oura sends the user back to the hub, then call sync_now to start the first download. Safe to call again for a fresh link. Does not share anything until the user approves in Oura.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async () => {
        const rt = getOuraRuntime();
        if (!rt) return { ...json({ error: "Oura isn't set up on the server: OURA_CLIENT_ID, OURA_CLIENT_SECRET (and the redirect URI) are missing." }), isError: true };
        return json(await startOuraConnect(getToolCtx().sql, rt.cfg));
      },
    );
}
