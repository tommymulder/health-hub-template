import { ToolError, type ToolCtx } from "../tools/context";
import { GENETICS_NOTE, noteFor } from "./notes";
import { buildWatchList } from "./watchlist";

interface StoredVariant {
  gene: string;
  variant: string;
  rsid: string | null;
  variant_copies: number;
  reported_as: string;
  collected_at: string;
  reported_at: string | null;
  source: string;
}

// Each tested variant, the hub's note where they carry at least one copy, and
// the blood markers those variants point at. Always ends with the same sentence.
export async function getGenetics(ctx: ToolCtx, input: { gene?: string } = {}) {
  const rows = await ctx.sql<StoredVariant[]>`
    select gene, variant, rsid, variant_copies, reported_as,
           collected_at::text as collected_at, reported_at::text as reported_at, source
    from genetic_variants
    order by gene, variant`;
  if (rows.length === 0) {
    throw new ToolError("No genetic results are stored yet. To add a report, show the user the extracted table and wait for a yes, then call log_genetic_variants. Never invent an rsID.");
  }
  const want = input.gene?.trim().toLowerCase();
  const matched = want ? rows.filter((r) => r.gene.toLowerCase() === want) : rows;
  if (matched.length === 0) throw new ToolError(`No stored variants for "${input.gene}". Stored genes: ${[...new Set(rows.map((r) => r.gene))].join(", ")}.`);

  const onePanel = matched.every((r) => r.source === matched[0].source && r.collected_at === matched[0].collected_at);
  const variants = matched.map((r) => {
    const copies = Number(r.variant_copies);
    const note = noteFor(r.gene, r.variant, copies, ctx.variantNotes);
    return {
      gene: r.gene,
      variant: r.variant,
      ...(r.rsid ? { rsid: r.rsid } : {}),
      variant_copies: copies,
      reported_as: r.reported_as,
      ...(!onePanel ? { source: r.source, collected_at: r.collected_at } : {}),
      ...(note ? { note: note.text } : {}),
    };
  });
  return {
    ...(onePanel ? { source: matched[0].source, collected_at: matched[0].collected_at, reported_at: matched[0].reported_at } : {}),
    variants,
    watch_list: await buildWatchList(ctx, matched),
    note: GENETICS_NOTE,
  };
}
