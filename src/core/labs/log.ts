import { inTx } from "../db";
import { localDate } from "../time";
import { ToolError, type ToolCtx } from "../tools/context";
import { DEXA_PANEL, dexaId, dexaName, dexaWarnings, type DexaRef } from "./dexa";
import { deriveFlag, isLoinc, labId, normFlag, normName, parseCollected, parseRef, parseValue } from "./norm";

export interface LabResultInput {
  test_name?: string; // required for a blood result; for a DEXA result the server builds it from `dexa`
  dexa?: DexaRef; // a DEXA measurement: { metric, region?, side? }

  loinc_code?: string;
  value: string | number;
  unit?: string;
  ref_low?: number;
  ref_high?: number;
  ref_text?: string;
  flag?: string;
  panel?: string;
}
export interface LabInput {
  collected_at: string;
  performer?: string;
  results: LabResultInput[];
}

const MAX_RESULTS = 200;
export const SOURCE_UPLOAD = "claude_upload";

interface Planned {
  id: string; name: string; unit: string | null; panel: string | null; isDexa: boolean; row: LabResultInput; collected_at: Date; num: number | null; text: string | null;
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: string | null; flag_derived: boolean;
}

function plan(ctx: ToolCtx, input: LabInput): { planned: Planned[]; collected: Date; dateOnly: boolean } {
  const problems: string[] = [];
  const when = parseCollected(input.collected_at ?? "", ctx.timezone);
  if (!when) problems.push(`collected_at "${input.collected_at}" isn't a date: use YYYY-MM-DD or a full timestamp.`);
  else if (when.at.getTime() > (ctx.now?.() ?? new Date()).getTime() + 86_400_000) problems.push(`collected_at ${input.collected_at} is in the future.`);
  if (!input.results?.length) problems.push("results is empty.");
  if ((input.results?.length ?? 0) > MAX_RESULTS) problems.push(`At most ${MAX_RESULTS} results per call: split the report.`);

  const planned: Planned[] = [];
  const seen = new Set<string>();
  (input.results ?? []).slice(0, MAX_RESULTS).forEach((r, i) => {
    const label = `result ${i + 1}${r?.test_name ? ` (${r.test_name})` : r?.dexa ? ` (DEXA ${r.dexa.metric})` : ""}`;
    if (!r?.test_name?.trim() && !r?.dexa) { problems.push(`${label}: test_name is missing.`); return; }
    if (r.value === undefined || r.value === null || String(r.value).trim() === "") { problems.push(`${label}: value is missing.`); return; }
    if (r.loinc_code && !isLoinc(r.loinc_code)) problems.push(`${label}: loinc_code "${r.loinc_code}" doesn't look like a LOINC code (e.g. 2093-3). Leave it out if unsure.`);
    if (r.ref_low !== undefined && r.ref_high !== undefined && r.ref_low > r.ref_high) problems.push(`${label}: ref_low is above ref_high.`);
    const v = parseValue(r.value);
    let name = r.test_name?.trim() ?? "", unit = r.unit ?? null, panel = r.panel ?? null, isDexa = false;
    if (r.dexa) {
      // A DEXA number: the name and unit come from the catalog (one vocabulary for every clinic), and it must be a number.
      const built = dexaName(r.dexa, r.unit);
      if (!built.ok) { problems.push(`${label}: ${built.error}`); return; }
      if (v.num === null) { problems.push(`${label}: a DEXA value must be a number (got "${r.value}").`); return; }
      name = built.name; unit = built.unit; panel = DEXA_PANEL; isDexa = true;
    }
    if (!when) return;
    const fromText = isDexa ? { low: null, high: null } : parseRef(r.ref_text);
    const low = isDexa ? undefined : r.ref_low ?? fromText.low ?? undefined, high = isDexa ? undefined : r.ref_high ?? fromText.high ?? undefined;
    const given = isDexa ? null : normFlag(r.flag);
    const derived = isDexa ? null : given ?? deriveFlag(v.num, low ?? null, high ?? null);
    const id = isDexa ? dexaId(name, localDate(when.at, ctx.timezone), input.performer) : labId(name, when.at, r.value, SOURCE_UPLOAD);
    if (seen.has(id)) { problems.push(`${label} appears twice in this report.`); return; }
    seen.add(id);
    planned.push({ id, name, unit, panel, isDexa, row: r, collected_at: when.at, num: v.num, text: v.text, ref_low: low ?? null, ref_high: high ?? null, ref_text: isDexa ? null : r.ref_text ?? null, flag: derived, flag_derived: !isDexa && given === null && derived !== null });
  });
  if (problems.length) throw new ToolError(`Nothing was saved. Fix these and call again:\n- ${problems.join("\n- ")}`);
  return { planned, collected: when!.at, dateOnly: when!.dateOnly };
}

// Saves lab results typed or read by Claude. Hub only (no Hevy). Same results twice change nothing (idempotent
// upsert on a content hash). `dry_run` shows exactly what would be saved and what is already there.
export async function logLabResults(ctx: ToolCtx, input: LabInput, opts: { dry_run?: boolean } = {}) {
  const { planned, collected } = plan(ctx, input);
  const ids = planned.map((p) => p.id);
  const stored = await ctx.sql<{ id: string; value_num: number | null; value_text: string | null }[]>`select id, value_num, value_text from lab_results where id = any(${ids})`;
  const existing = new Set(stored.map((r) => r.id));
  // A DEXA row whose id exists but whose number differs will be REPLACED by this save (a correction).
  const replaces = new Set(planned.filter((p) => p.isDexa && stored.some((o) => o.id === p.id && (o.value_num ?? o.value_text) !== (p.num ?? p.text))).map((p) => p.id));

  // Same test + moment + source but a DIFFERENT value: a correction, or a misread. Say so, don't silently add a second.
  const conflicts: string[] = [];
  const sameMoment = await ctx.sql<{ id: string; test_name: string; value_num: number | null; value_text: string | null }[]>`
    select id, test_name, value_num, value_text from lab_results where collected_at = ${collected} and source = ${SOURCE_UPLOAD}`;
  for (const p of planned) {
    if (existing.has(p.id) || p.isDexa) continue;
    const other = sameMoment.find((o) => normName(o.test_name) === normName(p.name));
    if (other) conflicts.push(`${p.name}: already stored for this date as ${other.value_num ?? other.value_text}, now ${p.row.value}. Both would be kept.`);
  }

  const warnings = dexaWarnings(planned.filter((p) => p.isDexa && p.num !== null).map((p) => ({ name: p.name, value: p.num as number, unit: p.unit })));
  const rows = planned.map((p) => ({
    test: p.name, value: p.num ?? p.text, unit: p.unit,
    reference: p.ref_text ?? (p.ref_low !== null || p.ref_high !== null ? `${p.ref_low ?? ""}-${p.ref_high ?? ""}` : null),
    flag: p.flag ? (p.flag_derived ? `${p.flag} (derived from the range)` : p.flag) : null,
    panel: p.panel, loinc: p.row.loinc_code ?? null, status: replaces.has(p.id) ? "will_replace" : existing.has(p.id) ? "already_stored" : "new",
  }));
  const summary = {
    collected: localDate(collected, ctx.timezone), performer: input.performer ?? null,
    new: planned.filter((p) => !existing.has(p.id)).length, already_stored: existing.size - replaces.size,
    ...(replaces.size ? { replaced: replaces.size } : {}),
    flagged: planned.filter((p) => p.flag && p.flag !== "normal").map((p) => `${p.name} ${p.flag}`),
    ...(planned.some((p) => !p.isDexa && p.row.unit === undefined && p.num !== null) ? { missing_units: planned.filter((p) => !p.isDexa && p.row.unit === undefined && p.num !== null).map((p) => p.name) } : {}),
    ...(conflicts.length ? { conflicts } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  if (opts.dry_run) return { dry_run: true, saved: false, summary, results: rows, next: "Show this table to the user, check it against the document, and only save (dry_run false) after a clear yes." };

  await inTx(ctx.sql, async (tx) => {
    for (const p of planned) {
      await tx`
        insert into lab_results (id, collected_at, test_name, loinc_code, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, panel, performer, source, raw)
        values (${p.id}, ${p.collected_at}, ${p.name}, ${p.row.loinc_code ?? null}, ${p.num}, ${p.text}, ${p.unit},
                ${p.ref_low}, ${p.ref_high}, ${p.ref_text}, ${p.flag}, ${p.panel}, ${input.performer ?? null}, ${SOURCE_UPLOAD},
                ${tx.json({ ...p.row, flag_derived: p.flag_derived } as never)})
        on conflict (id) do ${p.isDexa ? tx`update set collected_at = excluded.collected_at, value_num = excluded.value_num, value_text = excluded.value_text, unit = excluded.unit, raw = excluded.raw, imported_at = now()` : tx`nothing`}`;
    }
  });
  return { dry_run: false, saved: true, summary, results: rows };
}
