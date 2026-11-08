import { inTx } from "../db";
import { ToolError, type ToolCtx } from "../tools/context";

export interface VariantInput {
  gene: string;
  variant: string;
  rsid?: string | null;
  variant_copies: number;
  reported_as: string;
  raw?: unknown;
}
export interface GeneticsInput {
  source: string;
  collected_at: string;
  reported_at?: string;
  variants: VariantInput[];
}

const MAX_VARIANTS = 50;
const RSID = /^rs[0-9]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Planned {
  gene: string;
  variant: string;
  rsid: string | null;
  variant_copies: number;
  reported_as: string;
  raw: Record<string, unknown> | null;
}

// Check the whole call before touching the database. A raw-DNA file (hundreds of
// thousands of variants) does not belong in this tool.
export function planGeneticVariants(input: GeneticsInput): Planned[] {
  const problems: string[] = [];
  if (!input.source?.trim()) problems.push("source is missing (the lab or company that issued the report).");
  if (!DAY.test(input.collected_at ?? "")) problems.push(`collected_at "${input.collected_at ?? ""}" isn't a date: use YYYY-MM-DD.`);
  if (input.reported_at !== undefined && input.reported_at !== "" && !DAY.test(input.reported_at)) {
    problems.push(`reported_at "${input.reported_at}" isn't a date: use YYYY-MM-DD, or leave it out.`);
  }
  if (!input.variants?.length) problems.push("variants is empty.");
  if ((input.variants?.length ?? 0) > MAX_VARIANTS) {
    problems.push(`At most ${MAX_VARIANTS} variants per call. A raw-DNA file needs an import script, not this tool.`);
  }

  const planned: Planned[] = [];
  const seen = new Set<string>();
  (input.variants ?? []).slice(0, MAX_VARIANTS).forEach((v, i) => {
    const label = `variant ${i + 1}${v?.gene ? ` (${v.gene} ${v.variant ?? ""})` : ""}`;
    if (!v?.gene?.trim()) { problems.push(`${label}: gene is missing.`); return; }
    if (!v.variant?.trim()) { problems.push(`${label}: variant is missing.`); return; }
    if (!v.reported_as?.trim()) problems.push(`${label}: reported_as is missing (for example Heterozygous).`);
    const copies = v.variant_copies;
    if (!Number.isInteger(copies) || copies < 0 || copies > 2) {
      problems.push(`${label}: variant_copies must be 0, 1 or 2 (got ${String(copies)}).`);
    }
    const rsid = v.rsid?.trim() || null;
    if (rsid && !RSID.test(rsid)) problems.push(`${label}: rsid "${rsid}" isn't a valid rsID. Leave it out if you aren't sure. Never invent one.`);
    if (v.raw !== undefined && v.raw !== null && (typeof v.raw !== "object" || Array.isArray(v.raw))) {
      problems.push(`${label}: raw must be an object.`);
    }
    const key = `${v.gene.trim().toLowerCase()}|${v.variant.trim().toLowerCase()}`;
    if (seen.has(key)) { problems.push(`${label} is listed twice in this call.`); return; }
    seen.add(key);
    if (!v.gene?.trim() || !v.variant?.trim() || !Number.isInteger(copies)) return;
    planned.push({
      gene: v.gene.trim(),
      variant: v.variant.trim(),
      rsid,
      variant_copies: copies,
      reported_as: (v.reported_as ?? "").trim(),
      raw: v.raw && typeof v.raw === "object" && !Array.isArray(v.raw) ? v.raw as Record<string, unknown> : null,
    });
  });
  if (problems.length) throw new ToolError(`Nothing was saved. Fix these and call again:\n- ${problems.join("\n- ")}`);
  return planned;
}

interface Stored {
  gene: string;
  variant: string;
  rsid: string | null;
  variant_copies: number;
  reported_as: string;
}

// Saves a genetic report. Hub only. The same gene + variant + collection date +
// source a second time changes nothing. A different genotype for that key is
// reported and not overwritten: genotypes don't silently change.
export async function logGeneticVariants(ctx: ToolCtx, input: GeneticsInput) {
  const planned = planGeneticVariants(input);
  const source = input.source.trim();
  const existing = await ctx.sql<Stored[]>`
    select gene, variant, rsid, variant_copies, reported_as
    from genetic_variants
    where source = ${source} and collected_at = ${input.collected_at}`;
  const byKey = new Map(existing.map((r) => [`${r.gene.toLowerCase()}|${r.variant.toLowerCase()}`, r]));

  const conflicts: string[] = [];
  const rows = planned.map((p) => {
    const prev = byKey.get(`${p.gene.toLowerCase()}|${p.variant.toLowerCase()}`);
    if (!prev) return { ...p, status: "new" as const };
    const same = Number(prev.variant_copies) === p.variant_copies
      && (prev.rsid ?? null) === p.rsid
      && prev.reported_as === p.reported_as;
    if (!same) {
      conflicts.push(`${p.gene} ${p.variant}: already stored as ${prev.variant_copies} copies (${prev.reported_as}), now ${p.variant_copies} (${p.reported_as}). The stored row was kept.`);
      return { ...p, status: "conflict" as const };
    }
    return { ...p, status: "already_stored" as const };
  });
  if (conflicts.length) {
    throw new ToolError(`Nothing was saved. These variants are already stored with different details:\n- ${conflicts.join("\n- ")}`);
  }

  const fresh = rows.filter((r) => r.status === "new");
  if (fresh.length) {
    await inTx(ctx.sql, async (tx) => {
      for (const p of fresh) {
        await tx`
          insert into genetic_variants (gene, variant, rsid, variant_copies, reported_as, collected_at, reported_at, source, raw)
          values (${p.gene}, ${p.variant}, ${p.rsid}, ${p.variant_copies}, ${p.reported_as}, ${input.collected_at},
                  ${input.reported_at || null}, ${source}, ${p.raw ? tx.json(p.raw as never) : null})
          on conflict (gene, variant, collected_at, source) do nothing`;
      }
    });
  }
  return {
    saved: true,
    summary: {
      source,
      collected_at: input.collected_at,
      reported_at: input.reported_at ?? null,
      new: fresh.length,
      already_stored: rows.filter((r) => r.status === "already_stored").length,
    },
    variants: rows.map((r) => ({
      gene: r.gene, variant: r.variant, rsid: r.rsid, variant_copies: r.variant_copies, reported_as: r.reported_as, status: r.status,
    })),
  };
}
