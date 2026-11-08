import { createMcpHandler } from "mcp-handler";
import { enabledModules } from "@/core/modules";
import { register as registerApple } from "./tools/apple";
import { register as registerCheckins } from "./tools/checkins";
import { register as registerClasses } from "./tools/classes";
import { register as registerCore } from "./tools/core";
import { register as registerEvents } from "./tools/events";
import { register as registerGenetics } from "./tools/genetics";
import { register as registerHevy } from "./tools/hevy";
import { register as registerLabs } from "./tools/labs";
import { register as registerOura } from "./tools/oura";


// Which tools exist (DESIGN Phase 18). The core areas are always listed; Hevy's only when HEVY_API_KEY is set; an
// optional module's only when HUB_MODULES names it. A tool that is not registered cannot be called at all.
// Read from the environment on each request, so a changed setting needs only a redeploy.
export function buildHub(env: Record<string, string | undefined> = process.env) {
  const modules = enabledModules(env);
  return createMcpHandler(
    (server) => {
      registerCore(server);
      registerOura(server);
      registerApple(server);
      registerLabs(server);
      if (env.HEVY_API_KEY) registerHevy(server);
      if (modules.has("checkins")) registerCheckins(server);
      if (modules.has("classes")) registerClasses(server);
      if (modules.has("genetics")) registerGenetics(server);
      if (modules.has("events")) registerEvents(server);
    },
    { serverInfo: { name: "health-hub", version: "0.1.0" } },
  );
}

