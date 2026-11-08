import { mergeSameDraw, type MergeRow } from "../labs/merge";
import { labTrend } from "../labs/read";
import { todayLocal, type ToolCtx } from "../tools/context";
import { localDate } from "../time";
import { noteFor, variantLabel, type WatchId } from "./notes";

// Markers the carried variants point at, by LOINC (DESIGN §4.6).
// Homocysteine, serum folate and B12 are common methylation markers.
// Methylmalonic acid (serum/plasma) is LOINC 13964-2 (large US labs map
// that code). RBC folate is LOINC 2283-0 (loinc.org). Neither is a common panel item.
export const WATCH_MARKERS: Record<WatchId, { name: string; loinc: string }> = {
  homocysteine: { name: "Homocysteine", loinc: "13965-9" },
  folate_serum: { name: "Folate (serum)", loinc: "2284-8" },
  folate_rbc: { name: "Folate (RBC)", loinc: "2283-0" },
  b12: { name: "Vitamin B12", loinc: "2132-9" },
  mma: { name: "Methylmalonic acid", loinc: "13964-2" },
};

const WATCH_ORDER: WatchId[] = ["homocysteine", "folate_serum", "folate_rbc", "b12", "mma"];

// "More than 12 months ago." The anniversary itself is not stale.
export function isStale(collected: string, today: string, months = 12): boolean {
  return addMonths(collected, months) < today;
}

function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}

function wholeMonths(from: string, to: string): number {
  const [y, m, d] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let months = (ty - y) * 12 + (tm - m);
  if (td < d) months -= 1;
  return Math.max(0, months);
}

export function agoPhrase(from: string, today: string): string {
  const months = wholeMonths(from, today);
  if (months < 18) return months === 1 ? "about 1 month ago" : `about ${months} months ago`;
  const years = Math.round(months / 12);
  return years === 1 ? "about 1 year ago" : `about ${years} years ago`;
}

export function staleNote(name: string, date: string, today: string): string {
  return `${name} was last measured ${date} (${agoPhrase(date, today)}): worth asking your doctor to add it at your next blood draw.`;
}

interface LabHit extends MergeRow {
  loinc_code: string | null;
}

interface Carried {
  gene: string;
  variant: string;
  variant_copies: number;
}

// Latest merged result for each marker the carried variants point at.
export async function buildWatchList(ctx: ToolCtx, variants: Carried[]) {
  const wanted = new Map<WatchId, string[]>();
  for (const v of variants) {
    const note = noteFor(v.gene, v.variant, Number(v.variant_copies), ctx.variantNotes);
    if (!note) continue;
    const label = variantLabel(v.gene, v.variant, ctx.variantNotes);
    for (const id of note.watch) {
      const because = wanted.get(id) ?? [];
      if (!because.includes(label)) because.push(label);
      wanted.set(id, because);
    }
  }
  const ids = WATCH_ORDER.filter((id) => wanted.has(id));
  if (ids.length === 0) return [];

  const loincs = ids.map((id) => WATCH_MARKERS[id].loinc);
  const rows = await ctx.sql<LabHit[]>`
    select id, collected_at, loinc_code, value_num, value_text, unit, ref_low, ref_high, ref_text, performer
    from lab_results where loinc_code = any(${loincs})`;
  const byLoinc = new Map<string, LabHit[]>();
  for (const r of rows) {
    if (!r.loinc_code) continue;
    const g = byLoinc.get(r.loinc_code) ?? [];
    g.push(r);
    byLoinc.set(r.loinc_code, g);
  }

  const today = todayLocal(ctx);
  return ids.map((id) => {
    const marker = WATCH_MARKERS[id];
    const related_to = wanted.get(id) ?? [];
    const merged = mergeSameDraw(byLoinc.get(marker.loinc) ?? [], ctx.timezone, ctx.labPreferredPerformers);
    if (merged.length === 0) {
      return { marker: marker.name, loinc: marker.loinc, related_to, status: "not measured yet" as const };
    }
    const last = merged[merged.length - 1];
    const date = localDate(last.collected_at, ctx.timezone);
    const numeric = merged.filter((r) => r.value_num !== null).map((r) => ({ at: r.collected_at, v: Number(r.value_num) }));
    const stale = isStale(date, today);
    const latestValue = last.value_num ?? last.value_text;
    return {
      marker: marker.name,
      loinc: marker.loinc,
      related_to,
      latest: {
        value: latestValue,
        ...(last.unit ? { unit: last.unit } : {}),
        date,
        ...(last.performer ? { performer: last.performer } : {}),
        ...(last.reported_by.length > 1 ? { reported_by: last.reported_by } : {}),
      },
      ...(!last.unit ? { unit_note: "No unit was stored with the newest result, so it is shown as reported." } : {}),
      ...(last.value_num === null && numeric.length > 0
        ? { trend_note: "The newest result is not a plain number, so the trend uses the numeric results only." }
        : {}),
      trend: labTrend(numeric),
      stale,
      ...(stale ? { stale_note: staleNote(marker.name, date, today) } : {}),
    };
  });
}
