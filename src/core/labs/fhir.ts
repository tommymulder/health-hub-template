import { isLoinc, normFlag, normName, parseCollected, parseRef, parseValue } from "./norm";

// Pure parser for the FHIR records inside Apple's "Export All Health Data" (apple_health_export/clinical-records/*.json).
// Written against a REAL export (DESIGN 4.4 / section 14, Phase 8): no database, no Next imports (D9).
//
// What the real export looks like (2026-10-11):
//  - Observation files: category 'laboratory' (also 'vital-signs', 'imaging'); `category` is sometimes an object, sometimes a list.
//  - LabCorp results are NOT standalone: they sit inside DiagnosticReport.contained[] (11k of them), with a real `interpretation` flag.
//  - No provider name on an Observation. The Patient it belongs to identifies the feed.
//  - Values: valueQuantity {value, unit, comparator?} or valueString; some results have neither (comments).

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const L = (x: unknown): unknown[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const O = (x: unknown): Json => (x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : {});

export interface FhirLab {
  id: string;
  collected_at: Date;
  test_name: string;
  loinc_code: string | null;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  flag: string | null;
  panel: string | null;
  performer: string | null;
  raw: Json;
}

export interface FhirParseResult {
  results: FhirLab[];
  skipped: Record<string, number>;
  by_provider: Record<string, number>;
  unlabelled_patients: string[]; // patient ids we could not name: pass --label <prefix>=<name>
}

const GENERIC_PANELS = new Set(["laboratory report", "laboratory", "lab", "report"]);

const patientId = (ref: unknown): string => String(O(ref).reference ?? "").replace(/^Patient\//, "");

// Name the feed a Patient belongs to, from evidence in the export only: a LabCorp patient-id system, the managing
// organisation, or the organisation that issued the patient identifier (that is how a clinic's own patient portal appears).
// A general practitioner is a PERSON, not a provider, so it is never used. Anything else stays unnamed until the user labels it.
function providerOfPatient(p: Json): string | null {
  if (L(p.identifier).some((i) => String(O(i).system ?? "").includes("labcorp.com"))) return "LabCorp";
  const org = O(p.managingOrganization).display;
  if (typeof org === "string" && org) return org;
  for (const i of L(p.identifier)) {
    const a = O(O(i).assigner).display;
    if (typeof a === "string" && a) return a;
  }
  return null;
}

const hasCategory = (o: Json, code: string) => L(o.category).some((c) => L(O(c).coding).some((cc) => O(cc).code === code));

function loincOf(code: Json): string | null {
  for (const c of L(code.coding)) {
    const cc = O(c);
    if (String(cc.system ?? "").toLowerCase().includes("loinc") && typeof cc.code === "string" && isLoinc(cc.code)) return cc.code.trim();
  }
  return null;
}

function testName(code: Json): string | null {
  const text = typeof code.text === "string" ? code.text.trim() : "";
  if (text) return text;
  const loinc = L(code.coding).map(O).find((c) => String(c.system ?? "").toLowerCase().includes("loinc") && c.display);
  const any = L(code.coding).map(O).find((c) => c.display);
  const d = (loinc ?? any)?.display;
  return typeof d === "string" && d.trim() ? d.trim() : null;
}

function interpretationFlag(o: Json): string | null {
  for (const i of L(o.interpretation)) for (const c of L(O(i).coding)) { const f = normFlag(String(O(c).code ?? "")); if (f) return f; }
  return null;
}

// One Observation (standalone or contained) -> a lab row, or the reason it is not one.
function toLab(o: Json, ctx: { id: string; patient: string; provider: string | null; panel: string | null; fallbackWhen?: string; timeZone: string }): FhirLab | string {
  if (O(o).resourceType !== "Observation") return "not_an_observation";
  if (o.status === "entered-in-error") return "entered_in_error";
  if (!hasCategory(o, "laboratory")) {
    const first = L(o.category).map((c) => O(L(O(c).coding)[0]).code).find((c) => typeof c === "string");
    return `category_${first ?? "none"}`; // vital-signs, imaging...: not lab results
  }
  const name = testName(O(o.code));
  if (!name) return "no_test_name";
  if (L(o.component).length > 0 && o.valueQuantity === undefined && o.valueString === undefined) return "multi_part_result";

  let num: number | null = null, text: string | null = null, unit: string | null = null;
  const q = O(o.valueQuantity);
  if (typeof q.value === "number") {
    unit = typeof q.unit === "string" ? q.unit.trim() || null : typeof q.code === "string" ? q.code.trim() || null : null;
    if (typeof q.comparator === "string" && q.comparator) text = `${q.comparator}${q.value}`; // "<0.5" is a bound, not a measurement
    else num = q.value;
  } else if (typeof o.valueString === "string" && o.valueString.trim()) {
    const v = parseValue(o.valueString);
    num = v.num; text = v.text;
  } else return "no_value"; // comments and "absent" results

  const when = parseCollected(String(o.effectiveDateTime ?? ctx.fallbackWhen ?? o.issued ?? ""), ctx.timeZone);
  if (!when) return "no_date";

  const rr = O(L(o.referenceRange)[0]);
  const parsedRef = parseRef(typeof rr.text === "string" ? rr.text : null);
  const low = typeof O(rr.low).value === "number" ? (O(rr.low).value as number) : parsedRef.low;
  const high = typeof O(rr.high).value === "number" ? (O(rr.high).value as number) : parsedRef.high;
  const refText = typeof rr.text === "string" && rr.text.trim() ? rr.text.trim() : null;

  // Keep the original record (minus anything that names the patient) so nothing is lost if the parser improves.
  const { subject: _s, meta: _m, ...raw } = o; // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    id: ctx.id, collected_at: when.at, test_name: name, loinc_code: loincOf(O(o.code)), value_num: num, value_text: text, unit,
    ref_low: low, ref_high: high, ref_text: refText, flag: interpretationFlag(o), panel: ctx.panel, performer: ctx.provider, raw,
  };
}

export function parseClinicalRecords(resources: unknown[], timeZone: string, labels: Record<string, string> = {}): FhirParseResult {
  const skipped: Record<string, number> = {};
  const skip = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const all = resources.map(O);

  const provider = new Map<string, string>();
  for (const p of all.filter((r) => r.resourceType === "Patient")) {
    const name = providerOfPatient(p);
    if (name && typeof p.id === "string") provider.set(p.id, name);
  }
  const providerFor = (pid: string): string | null => {
    for (const [prefix, name] of Object.entries(labels)) if (pid.startsWith(prefix)) return name;
    return provider.get(pid) ?? null;
  };

  // Panel names come from the DiagnosticReport that lists the result (generic titles are ignored).
  const panelOf = new Map<string, string>();
  const reportName = (r: Json) => testName(O(r.code));
  for (const r of all.filter((x) => x.resourceType === "DiagnosticReport")) {
    const n = reportName(r);
    if (!n || GENERIC_PANELS.has(normName(n))) continue;
    for (const ref of L(r.result)) panelOf.set(String(O(ref).reference ?? "").replace(/^Observation\//, ""), n);
  }

  const results: FhirLab[] = [];
  const unlabelled = new Set<string>();
  const note = (pid: string, prov: string | null) => { if (!prov && pid) unlabelled.add(pid); };
  // The same LabCorp report is exported many times (one file per ordered test, each holding the whole order), so
  // the SAME result id arrives repeatedly; the copies are identical, so the first is kept and the rest are counted.
  const seenIds = new Set<string>();
  const push = (r: FhirLab | string) => {
    if (typeof r === "string") return skip(r);
    if (seenIds.has(r.id)) return skip("duplicate_copy");
    seenIds.add(r.id);
    results.push(r);
  };

  for (const o of all) {
    if (o.resourceType === "Observation" && typeof o.id === "string") {
      const pid = patientId(o.subject), prov = providerFor(pid);
      note(pid, prov);
      push(toLab(o, { id: `fhir:${o.id}`, patient: pid, provider: prov, panel: panelOf.get(o.id) ?? null, timeZone }));
    } else if (o.resourceType === "DiagnosticReport" && typeof o.id === "string") {
      const contained = L(o.contained).map(O).filter((c) => c.resourceType === "Observation");
      if (contained.length === 0) continue;
      const pid = patientId(o.subject), prov = providerFor(pid) ?? (String(O(o.performer).display ?? "").includes("Labcorp") ? "LabCorp" : null);
      note(pid, prov);
      const panel = reportName(o);
      for (const c of contained) {
        push(toLab(c, { id: `fhir:${o.id}/${c.id ?? results.length}`, patient: pid, provider: prov, panel: panel && !GENERIC_PANELS.has(normName(panel)) ? panel : null, fallbackWhen: typeof o.effectiveDateTime === "string" ? o.effectiveDateTime : undefined, timeZone }));
      }
    }
  }

  const by_provider: Record<string, number> = {};
  for (const r of results) by_provider[r.performer ?? "(unlabelled)"] = (by_provider[r.performer ?? "(unlabelled)"] ?? 0) + 1;
  return { results, skipped, by_provider, unlabelled_patients: [...unlabelled].sort() };
}
