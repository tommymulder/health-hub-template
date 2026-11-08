// Which optional areas of the hub are turned on (DESIGN Phase 18). One setting, HUB_MODULES, lists them:
//   HUB_MODULES=checkins,classes
// A module that is off registers no tools and its web routes answer 404. The core (Oura, Apple Health, labs, Hevy)
// has no switch of its own: each core source turns on when its own keys exist. No Next/Vercel imports (DESIGN D9).

export const OPTIONAL_MODULES = ["checkins", "classes", "genetics", "events"] as const;
export type ModuleName = (typeof OPTIONAL_MODULES)[number];

export const MODULE_INFO: Record<ModuleName, string> = {
  checkins: "Morning check-ins: a 1-5 wake-up rating from a phone Shortcut, and how it compares with the ring.",
  classes: "Class logging: photo of a class board to a finished Hevy workout, completion and coaching notes. Needs Hevy.",
  genetics: "Genetic variants you carry, with notes and a lab watch-list.",
  events: "One-press events from a phone button (for example bathroom trips) read next to sleep.",
};

export type ModuleSet = ReadonlySet<ModuleName>;

// Reads HUB_MODULES ("checkins, classes"). An unknown name is an error, not a silent skip: a typo would otherwise
// leave a module off with no hint why. The classes module needs Hevy (it writes the finished workout there).
export function parseModules(value: string | undefined, hevyOn: boolean): ModuleSet {
  const names = (value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = new Set<ModuleName>();
  for (const n of names) {
    if (!(OPTIONAL_MODULES as readonly string[]).includes(n)) {
      throw new Error(`HUB_MODULES: unknown module "${n}". Choose from: ${OPTIONAL_MODULES.join(", ")}.`);
    }
    out.add(n as ModuleName);
  }
  if (out.has("classes") && !hevyOn) throw new Error('HUB_MODULES: "classes" needs HEVY_API_KEY (it logs the finished class to Hevy).');
  return out;
}

export const enabledModules = (env: Record<string, string | undefined> = process.env): ModuleSet =>
  parseModules(env.HUB_MODULES, !!env.HEVY_API_KEY);

// A tool context built without modules (tests, scripts) behaves as "everything on", so core tests need no setup.
export const moduleOn = (ctx: { modules?: ModuleSet }, name: ModuleName): boolean => (ctx.modules ? ctx.modules.has(name) : true);
