import { z } from "zod";
import { logEvent } from "@/core/events/log";
import { DATE, writeTool, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "log_event",
      {
        title: "Log or fix a bathroom trip",
        description:
          "Save a bathroom trip the user forgot to log with their phone button, or hide a mistaken press. Hub only. " +
          "They log every trip (day and night) with one press and the hub stamps the time; use this ONLY when they say they forgot ('I got up around 3') or pressed by mistake. Read the night first (get_recovery shows each night's trips with ids and times, and the ring's wake-ups) and confirm the time with them before logging. " +
          "at: a local time like '03:10' with night = the wake-up date of that night (an evening time like '23:30' belongs to the evening before that date), or an ISO date-time like 2031-05-02T03:10 (in the hub's timezone unless it has an offset). At most 48 hours back, never in the future. It is saved as approximate with source 'claude'. note is optional (200 characters). " +
          "To fix a mis-press pass hide_id (an id from get_recovery); restore_id brings it back. Nothing is ever deleted. Give exactly one of at, hide_id or restore_id.",
        inputSchema: z.object({
          type: z.enum(["bathroom"]),
          at: z.string().optional().describe("03:10 (with night), or an ISO date-time"),
          night: DATE.optional().describe("Wake-up date of the night an 'HH:MM' time belongs to"),
          note: z.string().max(200).optional(),
          hide_id: z.number().int().optional().describe("Hide a mis-press (reversible)"),
          restore_id: z.number().int().optional().describe("Bring a hidden press back"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) => writeTool((ctx) => logEvent(ctx, input)),
    );
}
