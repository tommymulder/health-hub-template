// `npm run doctor`: checks that the hub is set up, and prints PASS / FAIL / SKIP lines. It never prints a value, only
// names and counts. The checks are plain functions of an env object and a few probes, so tests can run them with fakes.
import { enabledModules } from "./modules";

export interface Check { name: string; status: "pass" | "fail" | "skip"; detail?: string }

export interface Probes {
  /** Runs `select 1` and returns the public tables with their RLS flag; throws when the database can't be reached. */
  database: () => Promise<{ tables: { name: string; rls: boolean }[] }>;
  /** Asks Hevy for the workout count (a read-only call); throws on failure. */
  hevy?: () => Promise<number>;
  /** True when an Oura login is stored. */
  ouraConnected?: () => Promise<boolean>;
  /** The tables the schema should have (a few that prove migration 0001 ran). */
}

const REQUIRED = ["MCP_SECRET", "DATABASE_URL", "CRON_SECRET", "INGEST_KEY"] as const;
export const SCHEMA_PROOF = ["workouts", "oura_documents", "lab_results", "apple_samples", "class_sessions", "morning_checkins", "events", "genetic_variants"];

const set = (v: string | undefined) => !!v && v.trim() !== "";
const note = (e: unknown) => String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 120);

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export async function runDoctor(env: Record<string, string | undefined>, probes: Probes): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: Check["status"], detail?: string) => out.push({ name, status, detail });

  for (const k of REQUIRED) add(`env ${k}`, set(env[k]) ? "pass" : "fail", set(env[k]) ? undefined : "not set (see .env.example)");
  if (set(env.DATABASE_URL)) {
    try { new URL(env.DATABASE_URL!); add("DATABASE_URL is a URL", "pass"); } catch { add("DATABASE_URL is a URL", "fail", "does not parse as a URL"); }
  }
  add("TIMEZONE", !set(env.TIMEZONE) ? "fail" : validTimezone(env.TIMEZONE!) ? "pass" : "fail",
    !set(env.TIMEZONE) ? "not set: every day would be a UTC day" : validTimezone(env.TIMEZONE!) ? undefined : "not an IANA timezone name (for example America/New_York)");
  add("UNITS", !env.UNITS || env.UNITS === "kg" || env.UNITS === "lb" ? "pass" : "fail", env.UNITS ? (env.UNITS === "kg" || env.UNITS === "lb" ? undefined : "must be kg or lb") : "not set: defaults to kg");

  let modules: ReturnType<typeof enabledModules> | null = null;
  try { modules = enabledModules(env); add("HUB_MODULES", "pass", [...modules].join(", ") || "none on"); }
  catch (e) { add("HUB_MODULES", "fail", note(e)); }
  if (modules && (modules.has("checkins") || modules.has("events"))) add("env CHECKIN_KEY (for checkins / events)", set(env.CHECKIN_KEY) ? "pass" : "fail", set(env.CHECKIN_KEY) ? undefined : "not set");

  // Database: reachable, schema applied, row level security on EVERY table.
  if (set(env.DATABASE_URL)) {
    try {
      const { tables } = await probes.database();
      add("database reachable", "pass");
      const names = new Set(tables.map((t) => t.name));
      const missing = SCHEMA_PROOF.filter((t) => !names.has(t));
      add("schema applied", missing.length ? "fail" : "pass", missing.length ? `missing tables: ${missing.join(", ")}` : `${tables.length} tables`);
      const open = tables.filter((t) => !t.rls).map((t) => t.name);
      add("row level security on every table", open.length ? "fail" : "pass", open.length ? `RLS off on: ${open.join(", ")}` : undefined);
    } catch (e) { add("database reachable", "fail", note(e)); }
  } else add("database reachable", "skip", "no DATABASE_URL");

  // Sources: each is checked only when its own keys are set.
  if (set(env.HEVY_API_KEY) && probes.hevy) {
    try { add("Hevy answers", "pass", `${await probes.hevy()} workouts on the account`); } catch (e) { add("Hevy answers", "fail", note(e)); }
  } else add("Hevy answers", "skip", "HEVY_API_KEY not set (Hevy is optional)");
  if (set(env.OURA_CLIENT_ID) && set(env.OURA_CLIENT_SECRET)) {
    add("Oura app keys", "pass");
    if (probes.ouraConnected && set(env.DATABASE_URL)) {
      try { const c = await probes.ouraConnected(); add("Oura connected", c ? "pass" : "skip", c ? undefined : "not connected yet: ask your AI app to run connect_oura"); } catch (e) { add("Oura connected", "fail", note(e)); }
    }
  } else if (set(env.OURA_CLIENT_ID) || set(env.OURA_CLIENT_SECRET)) add("Oura app keys", "fail", "set both OURA_CLIENT_ID and OURA_CLIENT_SECRET");
  else add("Oura app keys", "skip", "not set (Oura is optional until you add it)");
  return out;
}

export const exitCode = (checks: Check[]) => (checks.some((c) => c.status === "fail") ? 1 : 0);
export const format = (c: Check) => `${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP"}  ${c.name}${c.detail ? `: ${c.detail}` : ""}`;
