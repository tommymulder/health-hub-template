import { z } from "zod";
import { excludeAppleSample, getBodyMetrics, getHealthData, listHealthTypes } from "@/core/tools/apple";
import { DATE, readTool, writeTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "get_body_metrics",
      {
        title: "Body weight and composition",
        description:
          "Weight trend from the user's scale (via Apple Health): each weigh-in with its 7-day moving average (single readings bounce with water and food, so read the average), the change over the window, pounds-per-week rate of change, plus body fat %, lean mass and BMI when the scale records them, and training sessions and volume per week alongside. It also carries a `dexa` block: the latest DEXA scan (the measured fat, lean and bone), the change since the previous scan (with a caution when the clinics differ), how the scale compared on scan day, left-vs-right lean mass and region fat %. Fat versus muscle claims come from DEXA only, between scan dates. Use for 'how is my weight trending?', 'how has my body composition changed?' and when planning training around body-weight goals. For weight alongside HRV, resting heart rate and training load week by week, use get_trends. Defaults to 90 days (up to 366). Uses the scale as the single source; other sources (like Hevy's own entry) are listed but kept out of the trend.",
        inputSchema: z.object({ days: z.number().int().min(1).max(366).optional(), source: z.string().optional().describe("Use a specific source instead of the scale (see other_sources in a previous answer).") }),
        annotations: READ,
      },
      async (input) => readTool("get_body_metrics", (ctx) => getBodyMetrics(ctx, input)),
    );

    server.registerTool(
      "list_health_types",
      {
        title: "List Apple Health data",
        description:
          "Which Apple Health metrics are stored in the hub: sample count, first and last date, and sources for each, plus Apple workout counts. Use to discover what exists before calling get_health_data, instead of guessing metric names. Oura-sourced data is never stored here (Oura comes from its own API).",
        inputSchema: z.object({}),
        annotations: READ,
      },
      async () => readTool("list_health_types", (ctx) => listHealthTypes(ctx)),
    );

    server.registerTool(
      "get_health_data",
      {
        title: "Apple Health data",
        description:
          "Any stored Apple Health metric (steps, walking speed, energy, body fat...) for a date window, as daily or weekly totals (steps, energy, distance: summed) or averages with min/max (readings), or individual samples with aggregate 'none' (newest 200). Weights are shown in the user's units, energy in kcal. Use list_health_types first to see the exact metric names. Defaults to the last 14 days, daily.",
        inputSchema: z.object({ metric: z.string().describe("Exact metric name, e.g. step_count"), start: DATE.optional(), end: DATE.optional(), aggregate: z.enum(["none", "day", "week"]).optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_health_data", (ctx) => getHealthData(ctx, input)),
    );

    server.registerTool(
      "exclude_apple_sample",
      {
        title: "Hide a bad Apple Health sample",
        description:
          "Hide one wrong data point (e.g. someone else stepped on the scale, or the dog) so no tool counts it. Reversible: nothing is deleted, and restore: true brings it back. Get the exact start_at (and source) from get_health_data with aggregate 'none'. Hidden samples stay hidden when the phone re-sends the same data. Changes only the hub, never Apple Health.",
        inputSchema: z.object({ metric: z.string(), start_at: z.string().describe("ISO timestamp exactly as shown by get_health_data"), source: z.string().optional(), restore: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => writeTool((ctx) => excludeAppleSample(ctx, input)),
    );
}
