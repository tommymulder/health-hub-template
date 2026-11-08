import { enabledModules, type ModuleName } from "@/core/modules";

// A route of an optional module answers 404 while the module is off (DESIGN Phase 18), before any key is checked:
// to a caller, the route simply does not exist. Read per request, like the tool list.
export function moduleOff(name: ModuleName): Response | null {
  return enabledModules().has(name) ? null : Response.json({ error: "not found" }, { status: 404 });
}
