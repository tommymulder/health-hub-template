import { daysBetween, localDate } from "../time";
import { ToolError, type ToolCtx } from "../tools/context";
import { canonUnit, convertibleKind, convertValue } from "./convert";
import { DEXA_PANEL } from "./dexa";
import { mergeSameDraw } from "./merge";
import { deriveFlag, isLoinc, normFlag, normName, type Flag } from "./norm";
import { OPTIMAL_AS_OF, OPTIMAL_BOOK, optimalBand, optimalText, type LabBand, type RangeBook } from "./ranges";

interface Row {
  id: string; collected_at: Date; test_name: string; loinc_code: string | null; value_num: number | null; value_text: string | null;
  unit: string | null; ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: string | null;
  panel: string | null; performer: string | null; source: string; flag_derived: boolean | null;
  reported_by?: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
// Empty fields only cost tokens: leave them out of what Claude reads.
const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
const OUT_OF_RANGE = new Set(["H", "L", "abnormal", "critical_high", "critical_low", "low", "high", "below_optimal", "above_optimal"]);
// "high"/"low" sit above "above_optimal"/"below_optimal": outside the standard band is the stronger call.
const flagRank = (f?: string | null) =>
  f === "high" || f === "low" || f === "H" || f === "L" || f === "critical_high" || f === "critical_low" ? 0
    : f === "above_optimal" || f === "below_optimal" || f === "abnormal" ? 1 : 2;

interface Series { key: string; loinc: string | null; names: Set<string>; rows: Row[] }

// One series per test. The LOINC code is the best key; rows without one join the series whose name they share.
function buildSeries(rows: Row[], timeZone: string, preferred: readonly string[] = []): Series[] {
  const nameToLoinc = new Map<string, string>();
  for (const r of rows) if (r.loinc_code) nameToLoinc.set(normName(r.test_name), r.loinc_code);
  const series = new Map<string, Series>();
  for (const r of rows) {
    const loinc = r.loinc_code ?? nameToLoinc.get(normName(r.test_name)) ?? null;
    const key = loinc ?? `name:${normName(r.test_name)}`;
    const s = series.get(key) ?? { key, loinc, names: new Set<string>(), rows: [] };
    s.names.add(r.test_name);
    s.rows.push(r);
    series.set(key, s);
  }
  // Same result listed twice (two providers, or two routes) counts once. See mergeSameDraw.
  for (const s of series.values()) s.rows = mergeSameDraw(s.rows, timeZone, preferred);
  return [...series.values()];
}

function matches(s: Series, test: string): boolean {
  if (isLoinc(test)) return s.loinc === test.trim();
  const want = normName(test).split(" ").filter(Boolean);
  const haystack = [...s.names].map(normName).join(" ");
  return want.length > 0 && want.every((w) => haystack.includes(w));
}

function showFlag(r: Row): { flag: string | null; flag_derived?: true } {
  const given = normFlag(r.flag);
  // A flag the hub worked out from the range at save time is stored as the flag but remembered as derived.
  if (given) return r.flag_derived ? { flag: given, flag_derived: true } : { flag: given };
  const d = deriveFlag(r.value_num, r.ref_low, r.ref_high);
  return d ? { flag: d, flag_derived: true } : { flag: null };
}

const refOf = (r: Row) =>
  r.ref_text ?? (r.ref_low !== null || r.ref_high !== null ? `${r.ref_low ?? ""}-${r.ref_high ?? ""}` : null);

// The lab's H lines up with the optimal list's "high"; its "normal" lines up with "optimal". Anything else is a real disagreement.
function labAgrees(lab: Flag, band: LabBand): boolean {
  if (lab === "normal" && band === "optimal") return true;
  if ((lab === "H" || lab === "critical_high") && band === "high") return true;
  if ((lab === "L" || lab === "critical_low") && band === "low") return true;
  return false;
}

// The optimal band when this test and unit are on the optimal list; otherwise the lab's own range and flag.
function judged(book: RangeBook, row: Row, value: number | null, unit: string | null): { reference?: string | null; reference_source?: string; flag?: string | null; flag_derived?: true; lab_reference?: string; lab_flag?: string } {
  const spec = value === null ? null : book.range(row.loinc_code, row.test_name, unit);
  if (spec && value !== null) {
    const flag = optimalBand(value, spec);
    const reference = optimalText(spec);
    const labRef = refOf(row);
    const labFlag = normFlag(row.flag);
    return {
      reference, reference_source: "optimal_range", flag,
      ...(labRef && labRef !== reference ? { lab_reference: labRef } : {}),
      ...(labFlag && !labAgrees(labFlag, flag) ? { lab_flag: labFlag } : {}),
    };
  }
  return { reference: refOf(row), ...showFlag(row) };
}

// Put a convertible series (glucose, cholesterol) into ONE unit, saying exactly what was converted.
function unify(s: Series): { unit: string | null; points: { row: Row; value: number | null; converted_from?: { value: number; unit: string } }[]; note?: string } {
  const kind = convertibleKind([...s.names][0], s.loinc);
  // Count units by their canonical form so "mg/dL" and "mg/dL (calc)" are one unit; show the most common spelling.
  const units = new Map<string, number>();
  const spelling = new Map<string, Map<string, number>>();
  for (const r of s.rows) {
    if (r.value_num === null || !r.unit) continue;
    const c = canonUnit(r.unit);
    units.set(c, (units.get(c) ?? 0) + 1);
    const sp = spelling.get(c) ?? new Map<string, number>();
    sp.set(r.unit, (sp.get(r.unit) ?? 0) + 1);
    spelling.set(c, sp);
  }
  const mainCanon = [...units].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const main = mainCanon ? [...(spelling.get(mainCanon) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null;
  if (units.size <= 1 || !kind || !main) {
    return {
      unit: main,
      points: s.rows.map((row) => ({ row, value: row.value_num })),
      ...(units.size > 1 ? { note: `Reported in different units (${[...spelling.values()].map((m) => [...m.keys()][0]).join(", ")}) and not a pair this tool converts: values are shown as reported, so don't compare them directly.` } : {}),
    };
  }
  let bad = false;
  const points = s.rows.map((row) => {
    if (row.value_num === null || !row.unit || canonUnit(row.unit) === canonUnit(main)) return { row, value: row.value_num };
    const v = convertValue(kind, row.value_num, row.unit, main);
    if (v === null) { bad = true; return { row, value: row.value_num }; }
    return { row, value: round(v), converted_from: { value: row.value_num, unit: row.unit } };
  });
  return {
    unit: main, points,
    note: bad ? `Mixed units (${[...spelling.values()].map((m) => [...m.keys()][0]).join(", ")}); some could not be converted and are shown as reported.`
      : `Some results came in other units and were converted to ${main} (${kind} conversion; originals shown as converted_from).`,
  };
}

export function labTrend(pts: { at: Date; v: number }[]) {
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const change = last.v - first.v;
  const pct = first.v !== 0 ? (change / Math.abs(first.v)) * 100 : null;
  const spanDays = daysBetween(localDate(first.at, "UTC"), localDate(last.at, "UTC"));
  let perYear: number | null = null;
  if (pts.length >= 3 && spanDays >= 90) {
    const xs = pts.map((p) => (p.at.getTime() - first.at.getTime()) / 86_400_000), n = pts.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = pts.reduce((a, p) => a + p.v, 0) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (pts[i].v - my), 0);
    if (sxx > 0) perYear = (sxy / sxx) * 365;
  }
  const direction = pct === null || Math.abs(pct) < 2 ? "flat" : change > 0 ? "up" : "down";
  return { direction, change: round(change), change_pct: pct === null ? null : round(pct, 1), per_year: perYear === null ? null : round(perYear), span_days: spanDays };
}

async function load(ctx: ToolCtx, since?: string): Promise<Row[]> {
  return ctx.sql<Row[]>`
    select id, collected_at, test_name, loinc_code, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, panel, performer, source, (raw->>'flag_derived')::boolean as flag_derived
    from lab_results where (${since ?? null}::date is null or (collected_at at time zone ${ctx.timezone})::date >= ${since ?? null}::date)
    order by collected_at`;
}

const CAP_SERIES = 150, CAP_POINTS = 100;
const DEXA_LIST_NOTE = "DEXA body-composition scans are stored too but not listed here: use get_body_metrics for the summary, or get_lab_results with panel DEXA for every number and its history.";

// Stored rows versus how many distinct results a read returns, for the imported blood labs (DEXA scans are counted
// separately). Used to check the real table.
export async function mergedLabCount(ctx: ToolCtx): Promise<{ stored: number; distinct: number }> {
  const rows = (await load(ctx)).filter((r) => r.panel !== DEXA_PANEL);
  const distinct = buildSeries(rows, ctx.timezone).reduce((n, s) => n + s.rows.length, 0);
  return { stored: rows.length, distinct };
}

export async function getLabResults(ctx: ToolCtx, input: { test?: string; panel?: string; since?: string }) {
  let rows = await load(ctx, input.since);
  if (input.panel) { const p = normName(input.panel); rows = rows.filter((r) => r.panel && normName(r.panel).includes(p)); }
  // DEXA scans are ~45 numbers each: left in the "latest per test" list they would crowd the blood tests out of its cap.
  // They are read with panel DEXA (every number), a test name, or get_body_metrics (the summary).
  const dexaHidden = !input.test && !input.panel && rows.some((r) => r.panel === DEXA_PANEL);
  if (dexaHidden) rows = rows.filter((r) => r.panel !== DEXA_PANEL);
  if (rows.length === 0 && dexaHidden) {
    return { mode: "latest_per_test", tests: 0, out_of_range: 0, results: [], note: DEXA_LIST_NOTE };
  }
  if (rows.length === 0) {
    throw new ToolError(input.test || input.panel || input.since ? "No stored lab results match that. Call get_lab_results with no arguments to see what exists." : "No lab results are stored yet.");
  }
  let series = buildSeries(rows, ctx.timezone, ctx.labPreferredPerformers);
  const book = ctx.optimalRanges ?? OPTIMAL_BOOK;
  const disclaimer = `Report values, ranges, flags and trends and relate them to training, sleep and weight data. Do not diagnose; suggest discussing out-of-range or worrying trends with a doctor.` +
    (book.ranges.length ? ` Where reference_source is optimal_range, the range and flag are the optimal band from the user's own optimal-ranges list (dated ${OPTIMAL_AS_OF}), not the performing lab. flag is that band: optimal, below_optimal, above_optimal, low, or high. lab_reference and lab_flag are what the lab printed, when they differ.` : "");

  if (!input.test) {
    const latest = series.map((s) => {
      const u = unify(s);
      const last = u.points[u.points.length - 1], prev = u.points[u.points.length - 2];
      const r = last.row;
      const unit = last.converted_from ? u.unit : r.unit;
      return compact({
        test: [...s.names][s.names.size - 1], loinc: s.loinc, panel: r.panel, value: last.value ?? r.value_text, unit: u.unit ?? r.unit,
        ...judged(book, r, last.value, unit), collected: localDate(r.collected_at, ctx.timezone), performer: r.performer,
        ...(r.reported_by && r.reported_by.length > 1 ? { reported_by: r.reported_by } : {}),
        results_on_file: s.rows.length,
        ...(prev && last.value !== null && prev.value !== null ? { previous: { value: prev.value, date: localDate(prev.row.collected_at, ctx.timezone) }, change: round(last.value - prev.value) } : {}),
        ...(u.note ? { unit_note: u.note } : {}),
      }) as { test: string; flag?: string | null; panel?: string | null } & Record<string, unknown>;
    });
    latest.sort((a, b) => flagRank(a.flag) - flagRank(b.flag) || String(a.panel ?? "~").localeCompare(String(b.panel ?? "~")) || a.test.localeCompare(b.test));
    const flagged = latest.filter((l) => OUT_OF_RANGE.has(l.flag ?? "")).length;
    return {
      mode: "latest_per_test", tests: latest.length, out_of_range: flagged,
      ...(latest.length > CAP_SERIES ? { truncated: `Showing ${CAP_SERIES} of ${latest.length} tests (flagged first); pass test or panel to narrow.` } : {}),
      results: latest.slice(0, CAP_SERIES), note: dexaHidden ? `${disclaimer} ${DEXA_LIST_NOTE}` : disclaimer,
    };
  }

  series = series.filter((s) => matches(s, input.test!));
  // An exact name goes first: "DEXA fat mass" also matches every region's fat mass, and the cap of 10 must not cut the
  // whole-body number off (found on production, 2026-10-21).
  const want = normName(input.test);
  series = [...series.filter((s) => [...s.names].some((n) => normName(n) === want)), ...series.filter((s) => ![...s.names].some((n) => normName(n) === want))];
  if (series.length === 0) throw new ToolError(`No stored test matches "${input.test}". Call get_lab_results with no arguments to see the test names, or pass a LOINC code.`);
  const shown = series.slice(0, 10);
  return {
    mode: "history", test_query: input.test, matched_tests: series.length,
    ...(series.length > shown.length ? { truncated: `Showing 10 of ${series.length} matching tests; use a more specific name or a LOINC code.` } : {}),
    series: shown.map((s) => {
      const u = unify(s);
      const numeric = u.points.filter((p) => p.value !== null).map((p) => ({ at: p.row.collected_at, v: p.value as number }));
      const lastPoint = u.points[u.points.length - 1];
      const last = lastPoint.row;
      const pts = u.points.slice(-CAP_POINTS);
      const latestJudge = judged(book, last, lastPoint.value, lastPoint.converted_from ? u.unit : last.unit);
      return {
        test: [...s.names][s.names.size - 1], other_names: [...s.names].slice(0, -1), loinc: s.loinc, panel: last.panel, unit: u.unit,
        latest_reference: latestJudge.reference ?? null, ...(latestJudge.reference_source ? { reference_source: latestJudge.reference_source } : {}),
        results_on_file: s.rows.length,
        trend: labTrend(numeric),
        ...(u.note ? { unit_note: u.note } : {}),
        history: pts.map((p) => compact({
          date: localDate(p.row.collected_at, ctx.timezone), value: p.value ?? p.row.value_text, ...(p.converted_from ? { converted_from: p.converted_from } : {}),
          ...judged(book, p.row, p.value, p.converted_from ? u.unit : p.row.unit), performer: p.row.performer,
          ...(p.row.reported_by && p.row.reported_by.length > 1 ? { reported_by: p.row.reported_by } : {}),
        })),
        ...(u.points.length > CAP_POINTS ? { history_note: `Showing the newest ${CAP_POINTS} of ${u.points.length}.` } : {}),
      };
    }),
    note: disclaimer,
  };
}
