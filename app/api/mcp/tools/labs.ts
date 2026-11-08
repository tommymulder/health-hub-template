import { z } from "zod";
import { logLabResults } from "@/core/labs/log";
import { getLabResults } from "@/core/labs/read";
import { DATE, readTool, writeTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "get_lab_results",
      {
        title: "Lab results",
        description:
          "The user's stored blood-test and other lab results. With no arguments: the LATEST result per test, out-of-range first, with the previous value and change. With `test` (a name like 'LDL' or 'fasting glucose', or a LOINC code like 2093-3): that test's full history with reference ranges, flags and a trend (direction, change, per-year slope). `panel` ('Lipid Panel') and `since` (YYYY-MM-DD) narrow it. The same result reported twice (same test, same local day, same value and unit), for example once by the clinic that ordered the draw and once by the lab that ran it, is returned once with reported_by listing both. A different value on the same day is kept separate. DEXA body-composition scans are stored here too (panel DEXA, names like 'DEXA lean mass (left arm)'): pass panel DEXA for every number and each one's history; the unfiltered list leaves them out (get_body_metrics has the summary). Original units are kept; only well-known pairs (glucose and cholesterol, mg/dL vs mmol/L) are converted, and the answer says when. " +
          "For the markers on the user's optimal-ranges list (if they set one up), reference and flag use that optimal band (reference_source optimal_range; flag is optimal, below_optimal, above_optimal, low, or high), not the performing lab's printed range. lab_reference and lab_flag keep the lab's own when they differ. Other tests still use the lab's range and flag. " +
          "You are NOT a doctor: report values, ranges, flags and trends and relate them to the user's training, sleep and weight (get_body_metrics, get_recovery, get_training_summary); never diagnose, and suggest discussing out-of-range or worrying trends with a doctor.",
        inputSchema: z.object({ test: z.string().optional(), panel: z.string().optional(), since: DATE.optional() }),
        annotations: READ,
      },
      async (input) => readTool("get_lab_results", (ctx) => getLabResults(ctx, input)),
    );

    server.registerTool(
      "log_lab_results",
      {
        title: "Save lab results",
        description:
          "Save lab results that Claude read from a photo, screenshot or PDF of a report (for labs that aren't in Apple Health). Hub only: nothing goes to Hevy. " +
          "WORKFLOW: (1) Read the whole document and extract EVERY result: test_name exactly as printed, value as printed (a number, or text like '<0.5' or 'Negative'), unit, the reference range (ref_low/ref_high, or ref_text like '<200'), the lab's own flag if printed, panel (e.g. 'Lipid Panel') and the collection date (collected_at, YYYY-MM-DD or a full timestamp; prefer the COLLECTION date over the report or print date) and performer (the lab). Add loinc_code only if you are sure; otherwise omit it. NEVER guess a value, unit or range that is unreadable: leave it out and say so. " +
          "(2) ALWAYS call with dry_run: true first, show the user the table, ask them to check it against the document, and only save (dry_run false) after a clear yes. (3) Saving the same report twice changes nothing. Original units are kept as printed. One call = one collection date; call again for a report with several dates. " +
          "DEXA / body-composition scans use this same tool: give each number as dexa: { metric, region?, side? } instead of test_name, and the server names it the same way for every clinic. metric: total_mass, lean_mass, fat_mass, bone_mass, body_fat_pct, visceral_fat_mass, visceral_fat_area, subcutaneous_fat_mass, android_gynoid_ratio, bmd, bmd_t_score, bmd_z_score, bmd_percentile, rsmi, rmr_estimate (whole body); with a region (arms, legs, trunk with side both/left/right; android, gynoid) use total_mass, lean_mass, fat_mass or region_fat_pct. Masses need their unit (lb or kg) as printed. Performer = the clinic. collected_at = the scan date. Save only numbers the report prints: never compute a missing one, never copy the clinic's percentile tables or category labels, and leave out anything the report doesn't print. Logging a scan again with a corrected number replaces the old number. The dry run warns when the numbers don't add up (left + right vs total, lean + fat + bone vs total, body fat %), which usually means a misread: check those against the report before saving.",
        inputSchema: z.object({
          collected_at: z.string().describe("Collection date YYYY-MM-DD, or a full ISO timestamp"),
          performer: z.string().optional().describe("Lab or provider, e.g. 'Example Lab'"),
          results: z.array(z.object({
            test_name: z.string().optional().describe("Blood-test name as printed. Leave out for a DEXA number (use dexa)."),
            dexa: z.object({ metric: z.string(), region: z.string().optional(), side: z.enum(["both", "left", "right"]).optional() }).optional(),
            loinc_code: z.string().optional(), value: z.union([z.string(), z.number()]), unit: z.string().optional(),
            ref_low: z.number().optional(), ref_high: z.number().optional(), ref_text: z.string().optional(), flag: z.string().optional(), panel: z.string().optional(),
          })).min(1).max(200),
          dry_run: z.boolean().optional().describe("Show what would be saved without saving"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ dry_run, ...input }) => writeTool((ctx) => logLabResults(ctx, input, { dry_run })),
    );
}
