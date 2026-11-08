import { inTx, type Sql } from "../db";
import { localDate } from "../time";
import type { FhirLab, FhirParseResult } from "./fhir";

export const SOURCE_APPLE = "apple_health_records";
const CHUNK = 500;

// Upsert parsed records keyed by their FHIR id, so importing the same export again changes nothing
// (and a corrected result replaces the old one). Returns what was new vs already there.
export async function upsertFhirLabs(sql: Sql, results: FhirLab[]) {
  const ids = results.map((r) => r.id);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 5000) {
    for (const r of await sql<{ id: string }[]>`select id from lab_results where id = any(${ids.slice(i, i + 5000)})`) existing.add(r.id);
  }
  await inTx(sql, async (tx) => {
    for (let i = 0; i < results.length; i += CHUNK) {
      const part = results.slice(i, i + CHUNK).map((r) => ({
        id: r.id, collected_at: r.collected_at, test_name: r.test_name, loinc_code: r.loinc_code, value_num: r.value_num, value_text: r.value_text,
        unit: r.unit, ref_low: r.ref_low, ref_high: r.ref_high, ref_text: r.ref_text, flag: r.flag, panel: r.panel, performer: r.performer,
        source: SOURCE_APPLE, raw: tx.json(r.raw as never),
      }));
      await tx`
        insert into lab_results ${tx(part, "id", "collected_at", "test_name", "loinc_code", "value_num", "value_text", "unit", "ref_low", "ref_high", "ref_text", "flag", "panel", "performer", "source", "raw")}
        on conflict (id) do update set
          collected_at = excluded.collected_at, test_name = excluded.test_name, loinc_code = excluded.loinc_code, value_num = excluded.value_num,
          value_text = excluded.value_text, unit = excluded.unit, ref_low = excluded.ref_low, ref_high = excluded.ref_high, ref_text = excluded.ref_text,
          flag = excluded.flag, panel = excluded.panel, performer = excluded.performer, raw = excluded.raw`;
    }
  });
  return { total: results.length, new: results.filter((r) => !existing.has(r.id)).length, already_there: existing.size };
}

// The plain-language summary the script prints (counts and dates only, never values).
export function summarizeImport(parsed: FhirParseResult, timeZone: string, counts?: { new: number; already_there: number }) {
  const dates = parsed.results.map((r) => r.collected_at.getTime());
  const flagged = parsed.results.filter((r) => r.flag && r.flag !== "normal").length;
  return {
    results: parsed.results.length,
    ...(counts ?? {}),
    from: dates.length ? localDate(new Date(Math.min(...dates)), timeZone) : null,
    to: dates.length ? localDate(new Date(Math.max(...dates)), timeZone) : null,
    flagged_by_the_lab: flagged,
    by_provider: parsed.by_provider,
    skipped_not_lab_results: parsed.skipped,
    ...(parsed.unlabelled_patients.length ? { unlabelled_patients: parsed.unlabelled_patients } : {}),
  };
}
