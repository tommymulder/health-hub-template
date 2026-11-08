import { localDate } from "../time";

// A stored lab row, just the fields the merge looks at. The reader and the genetics
// watch-list both pass their own row types through here.
export interface MergeRow {
  id: string;
  collected_at: Date;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  performer: string | null;
}

// A clinic can order a draw that a separate lab runs, and both may list the same result. Prefer the performing lab:
// name the labs you want to win in LAB_PREFERRED_PERFORMERS (comma list, most preferred first; a name matches any
// performer that contains it, ignoring case). A performer on the list ranks by its place; anything else ranks last.
function performerRank(performer: string | null, preferred: readonly string[]): number {
  const p = (performer ?? "").toLowerCase();
  const i = preferred.findIndex((name) => name !== "" && p.includes(name.toLowerCase()));
  return i === -1 ? preferred.length : i;
}

function hasRange(r: MergeRow): boolean {
  return (r.ref_text != null && r.ref_text.trim() !== "") || r.ref_low != null || r.ref_high != null;
}

// Numeric 1 and 1.0 are the same measurement. Text is trimmed and case-folded so
// "Negative" matches "negative". The unit is compared the same way; a missing
// unit and a blank unit are the same. "mg/dL" and "mg/dL (calc)" stay different.
function valueKey(r: MergeRow): string {
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (r.value_num !== null && r.value_num !== undefined && Number.isFinite(Number(r.value_num))) {
    return `n:${Number(r.value_num)}|${unit}`;
  }
  return `t:${(r.value_text ?? "").trim().toLowerCase()}|${unit}`;
}

// Same test, same local collection date, same value, same unit = one result that
// two systems listed. A different value on that day stays separate: it may be a
// real repeat. Stored rows are never deleted; this only changes what a read returns.
export function mergeSameDraw<T extends MergeRow>(rows: T[], timeZone: string, preferred: readonly string[] = []): (T & { reported_by: string[] })[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${localDate(r.collected_at, timeZone)}|${valueKey(r)}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const merged: (T & { reported_by: string[] })[] = [];
  for (const g of groups.values()) {
    const ranked = [...g].sort((a, b) => {
      const range = Number(hasRange(b)) - Number(hasRange(a));
      if (range !== 0) return range;
      const lab = performerRank(a.performer, preferred) - performerRank(b.performer, preferred);
      if (lab !== 0) return lab;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const reported_by = [...new Set(g.map((r) => r.performer).filter((p): p is string => !!p && p.trim() !== ""))].sort((a, b) => a.localeCompare(b));
    merged.push({ ...ranked[0], reported_by });
  }
  merged.sort((a, b) => a.collected_at.getTime() - b.collected_at.getTime() || a.id.localeCompare(b.id));
  return merged;
}
