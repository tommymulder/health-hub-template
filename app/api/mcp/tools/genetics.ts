import { z } from "zod";
import { logGeneticVariants } from "@/core/genetics/log";
import { getGenetics } from "@/core/genetics/read";
import { DATE, readTool, writeTool, READ, type Server } from "../shared";


export function register(server: Server) {
    server.registerTool(
      "get_genetics",
      {
        title: "Genetic results",
        description:
          "The user's stored genetic variants (a methylation panel) and the blood markers those variants point at. With no arguments: every tested variant, the hub's short note for variants they carry at least one copy of, and a watch-list (latest value, trend, and stale when the marker is more than 12 months old). Pass gene (for example MTHFR) to limit it. " +
          "Genes show tendencies, not diagnoses; the blood markers show what is actually happening. Use this as context next to get_lab_results, never as a diagnosis. Do not repeat a vendor report's personality descriptions or percent-functioning claims, and do not recommend supplements or doses. If a watch-list marker is stale, suggest they ask their doctor to add it at the next blood draw.",
        inputSchema: z.object({ gene: z.string().optional().describe("Limit to one gene, e.g. MTHFR") }),
        annotations: READ,
      },
      async (input) => readTool("get_genetics", (ctx) => getGenetics(ctx, input)),
    );

    server.registerTool(
      "log_genetic_variants",
      {
        title: "Save genetic variants",
        description:
          "Save genetic variants Claude read from a report (for example a methylation panel). Hub only: nothing goes to Hevy. " +
          "Show the extracted table and wait for a yes before calling. Never invent an rsID: include rsid only when it is printed and you are sure, otherwise omit it. " +
          "variant is the report's own text. variant_copies is 0 (not carried), 1 (heterozygous) or 2 (homozygous). One call is one report: source (the company), collected_at (YYYY-MM-DD), reported_at if printed, and every variant. " +
          "Saving the same report twice changes nothing. A raw-DNA file with hundreds of thousands of variants does not belong here.",
        inputSchema: z.object({
          source: z.string().describe("Who issued the report, e.g. 'Example Genetics Co'"),
          collected_at: DATE,
          reported_at: DATE.optional(),
          variants: z.array(z.object({
            gene: z.string(),
            variant: z.string().describe("As the report prints it"),
            rsid: z.string().optional().describe("Only when printed and certain. Never invent one."),
            variant_copies: z.number().int().min(0).max(2),
            reported_as: z.string().describe("Heterozygous, Homozygous Negative, Homozygous Positive, ..."),
            raw: z.record(z.string(), z.unknown()).optional().describe("Report text worth keeping, such as a medication caution"),
          })).min(1).max(50),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => writeTool((ctx) => logGeneticVariants(ctx, input)),
    );
}
