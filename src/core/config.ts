// Environment access in one place. No Next/Vercel imports (DESIGN D9).
import { parseHrZones } from "./oura/hr";
import { enabledModules, type ModuleSet } from "./modules";
import type { Units } from "./units";

export interface Config {
  databaseUrl: string;
  hevyApiKey: string | null; // null = Hevy is not set up: no Hevy tools, no Hevy sync
  modules: ModuleSet; // HUB_MODULES: the optional areas that are on
  labPreferredPerformers: string[]; // LAB_PREFERRED_PERFORMERS, most preferred first
  timezone: string;
  units: Units;
  hrMax: number; // only for finding a class's window (a raised-heart-rate stretch); zones come from hrZones
  hrZones: number[]; // lower bounds of Oura heart-rate zones 1-5
}

export function getConfig(env: Record<string, string | undefined> = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  const hevyApiKey = env.HEVY_API_KEY;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    hevyApiKey: hevyApiKey || null,
    modules: enabledModules(env),
    labPreferredPerformers: (env.LAB_PREFERRED_PERFORMERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    timezone: env.TIMEZONE || "UTC", // an IANA name such as America/New_York; set it, or every "day" is a UTC day
    units: env.UNITS === "lb" ? "lb" : "kg",
    hrMax: Number(env.HR_MAX) > 100 ? Number(env.HR_MAX) : 190,
    hrZones: parseHrZones(env.HR_ZONES),
  };
}

export interface OuraConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Oura is optional until connected, so this is separate from getConfig (Hevy keeps working without it).
export function getOuraConfig(env: Record<string, string | undefined> = process.env): OuraConfig {
  const clientId = env.OURA_CLIENT_ID;
  const clientSecret = env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("OURA_CLIENT_ID / OURA_CLIENT_SECRET are not set");
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  const redirectUri = env.OURA_REDIRECT_URI || (host ? `https://${host}/api/oura/callback` : "");
  if (!redirectUri) throw new Error("Set OURA_REDIRECT_URI (e.g. https://<app>.vercel.app/api/oura/callback)");
  return { clientId, clientSecret, redirectUri };
}
